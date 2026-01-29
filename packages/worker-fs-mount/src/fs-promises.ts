/**
 * Replacement module for node:fs/promises that routes mounted paths
 * to their WorkerFilesystem implementations.
 *
 * Users should alias this in their wrangler.toml:
 *
 * [alias]
 * "node:fs/promises" = "worker-fs-mount/fs"
 *
 * This module implements derived operations (readFile, writeFile, truncate,
 * cp, access, rename) on top of the core streaming interface.
 */

import { Buffer } from 'node:buffer';
import type { BigIntStats, Dirent, Stats } from 'node:fs';
// IMPORTANT: Use 'fs' not 'node:fs' to avoid wrangler alias loop
// Wrangler aliases are exact string matches, so 'fs' won't be caught
import * as nodeFs from 'fs';
import { findMount, getAsyncFs, getSyncFs } from './registry.js';
import type { DirEntry, Stat, SyncWorkerFilesystem, WorkerFilesystem } from './types.js';

// Get the real fs/promises from the sync module
const realFs = nodeFs.promises;

/**
 * Extract a string path from various PathLike types.
 */
function getPath(pathLike: unknown): string | null {
  if (typeof pathLike === 'string') return pathLike;
  if (pathLike instanceof URL) return pathLike.pathname;
  if (Buffer.isBuffer(pathLike)) return pathLike.toString('utf8');
  return null;
}

/**
 * Create a Node.js-style filesystem error.
 */
function createFsError(
  code: string,
  syscall: string,
  path: string,
  message?: string
): NodeJS.ErrnoException {
  const msg = message ?? `${code}: ${syscall} '${path}'`;
  const err = new Error(msg) as NodeJS.ErrnoException;
  err.code = code;
  err.syscall = syscall;
  err.path = path;
  return err;
}

/**
 * Convert our Stat type to a Node.js Stats-like object.
 */
function toNodeStats(s: Stat): Stats {
  const isFile = s.type === 'file';
  const isDir = s.type === 'directory';
  const isSymlink = s.type === 'symlink';

  const mtime = s.lastModified ?? new Date(0);
  const birthtime = s.created ?? new Date(0);

  const stats = {
    isFile: () => isFile,
    isDirectory: () => isDir,
    isSymbolicLink: () => isSymlink,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    dev: 0,
    ino: 0,
    mode: isDir ? 0o755 : 0o644,
    nlink: 1,
    uid: 0,
    gid: 0,
    rdev: 0,
    size: s.size,
    blksize: 4096,
    blocks: Math.ceil(s.size / 512),
    atimeMs: mtime.getTime(),
    mtimeMs: mtime.getTime(),
    ctimeMs: mtime.getTime(),
    birthtimeMs: birthtime.getTime(),
    atime: mtime,
    mtime: mtime,
    ctime: mtime,
    birthtime: birthtime,
  };

  return stats as Stats;
}

/**
 * Convert our DirEntry to a Node.js Dirent-like object.
 */
function toNodeDirent(entry: DirEntry, parentPath: string): Dirent {
  const isFile = entry.type === 'file';
  const isDir = entry.type === 'directory';
  const isSymlink = entry.type === 'symlink';

  const dirent = {
    name: entry.name,
    parentPath: parentPath,
    path: parentPath,
    isFile: () => isFile,
    isDirectory: () => isDir,
    isSymbolicLink: () => isSymlink,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };

  return dirent as Dirent;
}

// === Helper functions for derived operations ===

/**
 * Collect all chunks from a ReadableStream into a single Uint8Array.
 */
async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.length;
  }

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

/**
 * Write data to a WritableStream.
 */
async function writeToStream(stream: WritableStream<Uint8Array>, data: Uint8Array): Promise<void> {
  const writer = stream.getWriter();
  try {
    await writer.write(data);
  } finally {
    await writer.close();
  }
}

/**
 * Pipe a ReadableStream to a WritableStream.
 */
async function pipeStreams(
  readable: ReadableStream<Uint8Array>,
  writable: WritableStream<Uint8Array>
): Promise<void> {
  const reader = readable.getReader();
  const writer = writable.getWriter();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await writer.write(value);
    }
  } finally {
    await writer.close();
  }
}

/**
 * Recursively copy a directory using streaming.
 */
async function copyDirectoryRecursive(
  srcFs: WorkerFilesystem,
  srcPath: string,
  destFs: WorkerFilesystem,
  destPath: string
): Promise<void> {
  // Create destination directory
  await destFs.mkdir(destPath, { recursive: true });

  // List source directory
  const entries = await srcFs.readdir(srcPath);

  for (const entry of entries) {
    const srcChildPath = srcPath === '/' ? `/${entry.name}` : `${srcPath}/${entry.name}`;
    const destChildPath = destPath === '/' ? `/${entry.name}` : `${destPath}/${entry.name}`;

    if (entry.type === 'directory') {
      await copyDirectoryRecursive(srcFs, srcChildPath, destFs, destChildPath);
    } else if (entry.type === 'file') {
      const readStream = await srcFs.createReadStream(srcChildPath);
      const writeStream = await destFs.createWriteStream(destChildPath);
      await pipeStreams(readStream, writeStream);
    } else if (entry.type === 'symlink' && srcFs.readlink && destFs.symlink) {
      const target = await srcFs.readlink(srcChildPath);
      await destFs.symlink(destChildPath, target);
    }
  }
}

/**
 * Recursively copy a directory using sync filesystem.
 */
function copyDirectorySyncRecursive(
  srcFs: SyncWorkerFilesystem,
  srcPath: string,
  destFs: SyncWorkerFilesystem,
  destPath: string
): void {
  // Create destination directory
  destFs.mkdirSync(destPath, { recursive: true });

  // List source directory
  const entries = srcFs.readdirSync(srcPath);

  for (const entry of entries) {
    const srcChildPath = srcPath === '/' ? `/${entry.name}` : `${srcPath}/${entry.name}`;
    const destChildPath = destPath === '/' ? `/${entry.name}` : `${destPath}/${entry.name}`;

    if (entry.type === 'directory') {
      copyDirectorySyncRecursive(srcFs, srcChildPath, destFs, destChildPath);
    } else if (entry.type === 'file') {
      const data = srcFs.readFileSync(srcChildPath);
      destFs.writeFileSync(destChildPath, data);
    } else if (entry.type === 'symlink' && srcFs.readlinkSync && destFs.symlinkSync) {
      const target = srcFs.readlinkSync(srcChildPath);
      destFs.symlinkSync(destChildPath, target);
    }
  }
}

// === Wrapped Functions ===

export async function readFile(
  path: Parameters<typeof realFs.readFile>[0],
  options?: Parameters<typeof realFs.readFile>[1]
): Promise<Buffer | string> {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      const asyncFs = getAsyncFs(match);
      const syncFs = getSyncFs(match);

      let data: Uint8Array;

      if (asyncFs) {
        // Use streaming to read file
        const stream = await asyncFs.createReadStream(match.relativePath);
        data = await collectStream(stream);
      } else if (syncFs) {
        // Fall back to sync method
        data = syncFs.readFileSync(match.relativePath);
      } else {
        throw createFsError('ENOSYS', 'readFile', pathStr, 'Filesystem does not support reading');
      }

      const buffer = Buffer.from(data);

      const encoding =
        typeof options === 'string'
          ? options
          : typeof options === 'object' && options !== null
            ? options.encoding
            : undefined;

      if (encoding) {
        return buffer.toString(encoding as BufferEncoding);
      }
      return buffer;
    }
  }
  return realFs.readFile(path, options) as Promise<Buffer | string>;
}

export async function writeFile(
  path: Parameters<typeof realFs.writeFile>[0],
  data: Parameters<typeof realFs.writeFile>[1],
  options?: Parameters<typeof realFs.writeFile>[2]
): Promise<void> {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      let bytes: Uint8Array;
      if (typeof data === 'string') {
        bytes = new TextEncoder().encode(data);
      } else if (Buffer.isBuffer(data)) {
        bytes = new Uint8Array(data);
      } else if (data instanceof Uint8Array) {
        bytes = data;
      } else if (ArrayBuffer.isView(data)) {
        bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      } else {
        const chunks: Uint8Array[] = [];
        for await (const chunk of data as AsyncIterable<string | Uint8Array>) {
          if (typeof chunk === 'string') {
            chunks.push(new TextEncoder().encode(chunk));
          } else {
            chunks.push(new Uint8Array(chunk));
          }
        }
        const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
        bytes = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
      }

      const flag = typeof options === 'object' && options !== null ? options.flag : undefined;
      const isAppend = flag === 'a' || flag === 'a+';
      const isExclusive = flag === 'wx' || flag === 'xw';

      const asyncFs = getAsyncFs(match);
      const syncFs = getSyncFs(match);

      // Check exclusive flag
      if (isExclusive) {
        let existing: Stat | null;
        if (asyncFs) {
          existing = await asyncFs.stat(match.relativePath);
        } else if (syncFs) {
          existing = syncFs.statSync(match.relativePath);
        } else {
          throw createFsError('ENOSYS', 'writeFile', pathStr, 'Filesystem does not support stat');
        }
        if (existing) {
          throw createFsError('EEXIST', 'writeFile', pathStr);
        }
      }

      if (asyncFs) {
        // Use streaming to write file
        const stream = await asyncFs.createWriteStream(match.relativePath, {
          flags: isAppend ? 'a' : 'w',
        });
        await writeToStream(stream, bytes);
      } else if (syncFs) {
        // Fall back to sync method
        syncFs.writeFileSync(match.relativePath, bytes, {
          flags: isAppend ? 'a' : 'w',
        });
      } else {
        throw createFsError('ENOSYS', 'writeFile', pathStr, 'Filesystem does not support writing');
      }
      return;
    }
  }
  return realFs.writeFile(path, data, options);
}

export async function appendFile(
  path: Parameters<typeof realFs.appendFile>[0],
  data: Parameters<typeof realFs.appendFile>[1],
  options?: Parameters<typeof realFs.appendFile>[2]
): Promise<void> {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      let bytes: Uint8Array;
      if (typeof data === 'string') {
        bytes = new TextEncoder().encode(data);
      } else {
        bytes = new Uint8Array(data);
      }

      const asyncFs = getAsyncFs(match);
      const syncFs = getSyncFs(match);

      if (asyncFs) {
        // Use streaming with append flag
        const stream = await asyncFs.createWriteStream(match.relativePath, {
          flags: 'a',
        });
        await writeToStream(stream, bytes);
      } else if (syncFs) {
        // Fall back to sync method
        syncFs.writeFileSync(match.relativePath, bytes, { flags: 'a' });
      } else {
        throw createFsError('ENOSYS', 'appendFile', pathStr, 'Filesystem does not support writing');
      }
      return;
    }
  }
  return realFs.appendFile(path, data, options);
}

export async function stat(
  path: Parameters<typeof realFs.stat>[0],
  options?: Parameters<typeof realFs.stat>[1]
): Promise<Stats | BigIntStats> {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      const asyncFs = getAsyncFs(match);
      const syncFs = getSyncFs(match);

      let s: Stat | null;
      if (asyncFs) {
        s = await asyncFs.stat(match.relativePath, { followSymlinks: true });
      } else if (syncFs) {
        s = syncFs.statSync(match.relativePath, { followSymlinks: true });
      } else {
        throw createFsError('ENOSYS', 'stat', pathStr, 'Filesystem does not support stat');
      }

      if (!s) {
        throw createFsError('ENOENT', 'stat', pathStr);
      }
      return toNodeStats(s);
    }
  }
  return realFs.stat(path, options) as Promise<Stats | BigIntStats>;
}

export async function lstat(
  path: Parameters<typeof realFs.lstat>[0],
  options?: Parameters<typeof realFs.lstat>[1]
): Promise<Stats | BigIntStats> {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      const asyncFs = getAsyncFs(match);
      const syncFs = getSyncFs(match);

      let s: Stat | null;
      if (asyncFs) {
        s = await asyncFs.stat(match.relativePath, { followSymlinks: false });
      } else if (syncFs) {
        s = syncFs.statSync(match.relativePath, { followSymlinks: false });
      } else {
        throw createFsError('ENOSYS', 'lstat', pathStr, 'Filesystem does not support stat');
      }

      if (!s) {
        throw createFsError('ENOENT', 'lstat', pathStr);
      }
      return toNodeStats(s);
    }
  }
  return realFs.lstat(path, options) as Promise<Stats | BigIntStats>;
}

export async function readdir(
  path: Parameters<typeof realFs.readdir>[0],
  options?: Parameters<typeof realFs.readdir>[1]
): Promise<string[] | Buffer[] | Dirent[]> {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      const opts = typeof options === 'object' && options !== null ? options : {};
      const recursive = 'recursive' in opts ? opts.recursive === true : false;

      const asyncFs = getAsyncFs(match);
      const syncFs = getSyncFs(match);

      let entries: DirEntry[];
      if (asyncFs) {
        entries = await asyncFs.readdir(match.relativePath, { recursive });
      } else if (syncFs) {
        entries = syncFs.readdirSync(match.relativePath, { recursive });
      } else {
        throw createFsError('ENOSYS', 'readdir', pathStr, 'Filesystem does not support readdir');
      }

      const withFileTypes = 'withFileTypes' in opts ? opts.withFileTypes === true : false;

      if (withFileTypes) {
        return entries.map((e) => toNodeDirent(e, pathStr));
      }

      const encoding =
        typeof options === 'string'
          ? options
          : typeof options === 'object' && options !== null && 'encoding' in options
            ? options.encoding
            : undefined;

      if (encoding === 'buffer') {
        return entries.map((e) => Buffer.from(e.name));
      }

      return entries.map((e) => e.name);
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return realFs.readdir(path, options as any) as Promise<string[] | Buffer[] | Dirent[]>;
}

export async function mkdir(
  path: Parameters<typeof realFs.mkdir>[0],
  options?: Parameters<typeof realFs.mkdir>[1]
): Promise<string | undefined> {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      const recursive =
        typeof options === 'object' && options !== null && options.recursive === true;

      const asyncFs = getAsyncFs(match);
      const syncFs = getSyncFs(match);

      if (asyncFs) {
        return asyncFs.mkdir(match.relativePath, { recursive });
      } else if (syncFs) {
        return syncFs.mkdirSync(match.relativePath, { recursive });
      } else {
        throw createFsError('ENOSYS', 'mkdir', pathStr, 'Filesystem does not support mkdir');
      }
    }
  }
  return realFs.mkdir(path, options) as Promise<string | undefined>;
}

export async function rm(
  path: Parameters<typeof realFs.rm>[0],
  options?: Parameters<typeof realFs.rm>[1]
): Promise<void> {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      const recursive = options?.recursive === true;
      const force = options?.force === true;

      const asyncFs = getAsyncFs(match);
      const syncFs = getSyncFs(match);

      if (asyncFs) {
        return asyncFs.rm(match.relativePath, { recursive, force });
      } else if (syncFs) {
        return syncFs.rmSync(match.relativePath, { recursive, force });
      } else {
        throw createFsError('ENOSYS', 'rm', pathStr, 'Filesystem does not support rm');
      }
    }
  }
  return realFs.rm(path, options);
}

export async function rmdir(
  path: Parameters<typeof realFs.rmdir>[0],
  options?: { maxRetries?: number; retryDelay?: number }
): Promise<void> {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      const asyncFs = getAsyncFs(match);
      const syncFs = getSyncFs(match);

      if (asyncFs) {
        return asyncFs.rm(match.relativePath, { recursive: false, force: false });
      } else if (syncFs) {
        return syncFs.rmSync(match.relativePath, { recursive: false, force: false });
      } else {
        throw createFsError('ENOSYS', 'rmdir', pathStr, 'Filesystem does not support rm');
      }
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (realFs.rmdir as any)(path, options);
}

export async function unlink(path: Parameters<typeof realFs.unlink>[0]): Promise<void> {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      const asyncFs = getAsyncFs(match);
      const syncFs = getSyncFs(match);

      // Derive unlink from stat + rm
      let s: Stat | null;
      if (asyncFs) {
        s = await asyncFs.stat(match.relativePath);
      } else if (syncFs) {
        s = syncFs.statSync(match.relativePath);
      } else {
        throw createFsError('ENOSYS', 'unlink', pathStr, 'Filesystem does not support stat');
      }

      if (!s) {
        throw createFsError('ENOENT', 'unlink', pathStr);
      }
      if (s.type === 'directory') {
        throw createFsError('EISDIR', 'unlink', pathStr);
      }

      if (asyncFs) {
        return asyncFs.rm(match.relativePath);
      } else if (syncFs) {
        return syncFs.rmSync(match.relativePath);
      }
    }
  }
  return realFs.unlink(path);
}

export async function rename(
  oldPath: Parameters<typeof realFs.rename>[0],
  newPath: Parameters<typeof realFs.rename>[1]
): Promise<void> {
  const oldPathStr = getPath(oldPath);
  const newPathStr = getPath(newPath);

  if (oldPathStr && newPathStr) {
    const oldMatch = findMount(oldPathStr);
    const newMatch = findMount(newPathStr);

    // Cross-mount rename not supported
    if (oldMatch?.mount !== newMatch?.mount) {
      throw createFsError('EXDEV', 'rename', oldPathStr, 'Cross-mount rename not supported');
    }

    if (oldMatch && newMatch) {
      const asyncFs = getAsyncFs(oldMatch);
      const syncFs = getSyncFs(oldMatch);

      // Get source stat
      let srcStat: Stat | null;
      if (asyncFs) {
        srcStat = await asyncFs.stat(oldMatch.relativePath);
      } else if (syncFs) {
        srcStat = syncFs.statSync(oldMatch.relativePath);
      } else {
        throw createFsError('ENOSYS', 'rename', oldPathStr, 'Filesystem does not support stat');
      }

      if (!srcStat) {
        throw createFsError('ENOENT', 'rename', oldPathStr);
      }

      if (asyncFs) {
        if (srcStat.type === 'directory') {
          // Recursive directory copy + delete
          await copyDirectoryRecursive(
            asyncFs,
            oldMatch.relativePath,
            asyncFs,
            newMatch.relativePath
          );
          await asyncFs.rm(oldMatch.relativePath, { recursive: true });
        } else if (srcStat.type === 'file') {
          // Stream copy + delete
          const readStream = await asyncFs.createReadStream(oldMatch.relativePath);
          const writeStream = await asyncFs.createWriteStream(newMatch.relativePath);
          await pipeStreams(readStream, writeStream);
          await asyncFs.rm(oldMatch.relativePath);
        } else if (srcStat.type === 'symlink') {
          // Copy symlink + delete
          if (asyncFs.readlink && asyncFs.symlink) {
            const target = await asyncFs.readlink(oldMatch.relativePath);
            await asyncFs.symlink(newMatch.relativePath, target);
            await asyncFs.rm(oldMatch.relativePath);
          } else {
            throw createFsError('ENOSYS', 'rename', oldPathStr, 'symlink operations not supported');
          }
        }
      } else if (syncFs) {
        if (srcStat.type === 'directory') {
          // Recursive directory copy + delete (sync)
          copyDirectorySyncRecursive(
            syncFs,
            oldMatch.relativePath,
            syncFs,
            newMatch.relativePath
          );
          syncFs.rmSync(oldMatch.relativePath, { recursive: true });
        } else if (srcStat.type === 'file') {
          // Read + write + delete (sync)
          const data = syncFs.readFileSync(oldMatch.relativePath);
          syncFs.writeFileSync(newMatch.relativePath, data);
          syncFs.rmSync(oldMatch.relativePath);
        } else if (srcStat.type === 'symlink') {
          // Copy symlink + delete
          if (syncFs.readlinkSync && syncFs.symlinkSync) {
            const target = syncFs.readlinkSync(oldMatch.relativePath);
            syncFs.symlinkSync(newMatch.relativePath, target);
            syncFs.rmSync(oldMatch.relativePath);
          } else {
            throw createFsError('ENOSYS', 'rename', oldPathStr, 'symlink operations not supported');
          }
        }
      }
      return;
    }
  }

  return realFs.rename(oldPath, newPath);
}

export async function copyFile(
  src: Parameters<typeof realFs.copyFile>[0],
  dest: Parameters<typeof realFs.copyFile>[1],
  mode?: Parameters<typeof realFs.copyFile>[2]
): Promise<void> {
  const srcStr = getPath(src);
  const destStr = getPath(dest);

  if (srcStr && destStr) {
    const srcMatch = findMount(srcStr);
    const destMatch = findMount(destStr);

    if (srcMatch || destMatch) {
      // Use streaming/sync for copy
      if (srcMatch && destMatch) {
        const srcAsyncFs = getAsyncFs(srcMatch);
        const destAsyncFs = getAsyncFs(destMatch);
        const srcSyncFs = getSyncFs(srcMatch);
        const destSyncFs = getSyncFs(destMatch);

        if (srcAsyncFs && destAsyncFs) {
          // Both have async - pipe streams
          const readStream = await srcAsyncFs.createReadStream(srcMatch.relativePath);
          const writeStream = await destAsyncFs.createWriteStream(destMatch.relativePath);
          await pipeStreams(readStream, writeStream);
        } else if (srcSyncFs && destSyncFs) {
          // Both have sync - read and write
          const data = srcSyncFs.readFileSync(srcMatch.relativePath);
          destSyncFs.writeFileSync(destMatch.relativePath, data);
        } else if (srcAsyncFs && destSyncFs) {
          // Mixed: async read, sync write
          const stream = await srcAsyncFs.createReadStream(srcMatch.relativePath);
          const data = await collectStream(stream);
          destSyncFs.writeFileSync(destMatch.relativePath, data);
        } else if (srcSyncFs && destAsyncFs) {
          // Mixed: sync read, async write
          const data = srcSyncFs.readFileSync(srcMatch.relativePath);
          const stream = await destAsyncFs.createWriteStream(destMatch.relativePath);
          await writeToStream(stream, data);
        } else {
          throw createFsError('ENOSYS', 'copyFile', srcStr, 'Filesystem does not support copy operations');
        }
      } else if (srcMatch) {
        // Source on mount, dest on real fs
        const srcAsyncFs = getAsyncFs(srcMatch);
        const srcSyncFs = getSyncFs(srcMatch);

        if (srcAsyncFs) {
          const readStream = await srcAsyncFs.createReadStream(srcMatch.relativePath);
          const data = await collectStream(readStream);
          await realFs.writeFile(dest, data);
        } else if (srcSyncFs) {
          const data = srcSyncFs.readFileSync(srcMatch.relativePath);
          await realFs.writeFile(dest, data);
        } else {
          throw createFsError('ENOSYS', 'copyFile', srcStr, 'Filesystem does not support reading');
        }
      } else if (destMatch) {
        // Source on real fs, dest on mount
        const destAsyncFs = getAsyncFs(destMatch);
        const destSyncFs = getSyncFs(destMatch);

        const buffer = await realFs.readFile(src);
        const data = new Uint8Array(buffer);

        if (destAsyncFs) {
          const writeStream = await destAsyncFs.createWriteStream(destMatch.relativePath);
          await writeToStream(writeStream, data);
        } else if (destSyncFs) {
          destSyncFs.writeFileSync(destMatch.relativePath, data);
        } else {
          throw createFsError('ENOSYS', 'copyFile', destStr, 'Filesystem does not support writing');
        }
      }
      return;
    }
  }

  return realFs.copyFile(src, dest, mode);
}

export async function cp(
  src: Parameters<typeof realFs.cp>[0],
  dest: Parameters<typeof realFs.cp>[1],
  options?: Parameters<typeof realFs.cp>[2]
): Promise<void> {
  const srcStr = getPath(src);
  const destStr = getPath(dest);

  if (srcStr && destStr) {
    const srcMatch = findMount(srcStr);
    const destMatch = findMount(destStr);

    if (srcMatch || destMatch) {
      // Check if source is a directory
      let isDirectory = false;

      if (srcMatch) {
        const srcAsyncFs = getAsyncFs(srcMatch);
        const srcSyncFs = getSyncFs(srcMatch);

        let srcStat: Stat | null;
        if (srcAsyncFs) {
          srcStat = await srcAsyncFs.stat(srcMatch.relativePath);
        } else if (srcSyncFs) {
          srcStat = srcSyncFs.statSync(srcMatch.relativePath);
        } else {
          throw createFsError('ENOSYS', 'cp', srcStr, 'Filesystem does not support stat');
        }
        isDirectory = srcStat?.type === 'directory';
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const realStat = await realFs.stat(src as any);
        isDirectory = realStat.isDirectory();
      }

      if (isDirectory) {
        if (!options?.recursive) {
          throw createFsError('EISDIR', 'cp', srcStr, 'cp requires recursive for directories');
        }

        if (srcMatch && destMatch) {
          const srcAsyncFs = getAsyncFs(srcMatch);
          const destAsyncFs = getAsyncFs(destMatch);
          const srcSyncFs = getSyncFs(srcMatch);
          const destSyncFs = getSyncFs(destMatch);

          if (srcAsyncFs && destAsyncFs) {
            await copyDirectoryRecursive(
              srcAsyncFs,
              srcMatch.relativePath,
              destAsyncFs,
              destMatch.relativePath
            );
          } else if (srcSyncFs && destSyncFs) {
            copyDirectorySyncRecursive(
              srcSyncFs,
              srcMatch.relativePath,
              destSyncFs,
              destMatch.relativePath
            );
          } else {
            throw createFsError(
              'ENOSYS',
              'cp',
              srcStr,
              'Mixed async/sync directory copy not supported'
            );
          }
        } else {
          throw createFsError(
            'EXDEV',
            'cp',
            srcStr,
            'Directory copy across mount boundary not supported'
          );
        }
      } else {
        // File copy using streaming/sync
        if (srcMatch && destMatch) {
          const srcAsyncFs = getAsyncFs(srcMatch);
          const destAsyncFs = getAsyncFs(destMatch);
          const srcSyncFs = getSyncFs(srcMatch);
          const destSyncFs = getSyncFs(destMatch);

          if (srcAsyncFs && destAsyncFs) {
            const readStream = await srcAsyncFs.createReadStream(srcMatch.relativePath);
            const writeStream = await destAsyncFs.createWriteStream(destMatch.relativePath);
            await pipeStreams(readStream, writeStream);
          } else if (srcSyncFs && destSyncFs) {
            const data = srcSyncFs.readFileSync(srcMatch.relativePath);
            destSyncFs.writeFileSync(destMatch.relativePath, data);
          } else if (srcAsyncFs && destSyncFs) {
            const stream = await srcAsyncFs.createReadStream(srcMatch.relativePath);
            const data = await collectStream(stream);
            destSyncFs.writeFileSync(destMatch.relativePath, data);
          } else if (srcSyncFs && destAsyncFs) {
            const data = srcSyncFs.readFileSync(srcMatch.relativePath);
            const stream = await destAsyncFs.createWriteStream(destMatch.relativePath);
            await writeToStream(stream, data);
          } else {
            throw createFsError('ENOSYS', 'cp', srcStr, 'Filesystem does not support copy');
          }
        } else if (srcMatch) {
          const srcAsyncFs = getAsyncFs(srcMatch);
          const srcSyncFs = getSyncFs(srcMatch);

          if (srcAsyncFs) {
            const readStream = await srcAsyncFs.createReadStream(srcMatch.relativePath);
            const data = await collectStream(readStream);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await realFs.writeFile(dest as any, data);
          } else if (srcSyncFs) {
            const data = srcSyncFs.readFileSync(srcMatch.relativePath);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await realFs.writeFile(dest as any, data);
          }
        } else if (destMatch) {
          const destAsyncFs = getAsyncFs(destMatch);
          const destSyncFs = getSyncFs(destMatch);

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const buffer = await realFs.readFile(src as any);
          const data = new Uint8Array(buffer);

          if (destAsyncFs) {
            const writeStream = await destAsyncFs.createWriteStream(destMatch.relativePath);
            await writeToStream(writeStream, data);
          } else if (destSyncFs) {
            destSyncFs.writeFileSync(destMatch.relativePath, data);
          }
        }
      }
      return;
    }
  }

  return realFs.cp(src, dest, options);
}

export async function access(
  path: Parameters<typeof realFs.access>[0],
  mode?: Parameters<typeof realFs.access>[1]
): Promise<void> {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      const asyncFs = getAsyncFs(match);
      const syncFs = getSyncFs(match);

      // Derive from stat - just check if it exists
      let s: Stat | null;
      if (asyncFs) {
        s = await asyncFs.stat(match.relativePath);
      } else if (syncFs) {
        s = syncFs.statSync(match.relativePath);
      } else {
        throw createFsError('ENOSYS', 'access', pathStr, 'Filesystem does not support stat');
      }

      if (!s) {
        throw createFsError('ENOENT', 'access', pathStr);
      }
      return;
    }
  }
  return realFs.access(path, mode);
}

export async function truncate(
  path: Parameters<typeof realFs.truncate>[0],
  len?: Parameters<typeof realFs.truncate>[1]
): Promise<void> {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      const length = len ?? 0;
      const asyncFs = getAsyncFs(match);
      const syncFs = getSyncFs(match);

      // Get source stat
      let srcStat: Stat | null;
      if (asyncFs) {
        srcStat = await asyncFs.stat(match.relativePath);
      } else if (syncFs) {
        srcStat = syncFs.statSync(match.relativePath);
      } else {
        throw createFsError('ENOSYS', 'truncate', pathStr, 'Filesystem does not support stat');
      }

      if (!srcStat) {
        throw createFsError('ENOENT', 'truncate', pathStr);
      }
      if (srcStat.type !== 'file') {
        throw createFsError('EISDIR', 'truncate', pathStr);
      }

      let newData: Uint8Array;

      if (asyncFs) {
        if (length === 0) {
          // Truncate to empty
          newData = new Uint8Array(0);
        } else if (length >= srcStat.size) {
          // Extend with zeros
          const readStream = await asyncFs.createReadStream(match.relativePath);
          const existingData = await collectStream(readStream);
          newData = new Uint8Array(length);
          newData.set(existingData, 0);
          // Rest is already zeros
        } else {
          // Truncate to smaller size - read only what we need
          const readStream = await asyncFs.createReadStream(match.relativePath, {
            start: 0,
            end: length - 1,
          });
          newData = await collectStream(readStream);
        }

        const writeStream = await asyncFs.createWriteStream(match.relativePath);
        await writeToStream(writeStream, newData);
      } else if (syncFs) {
        if (length === 0) {
          // Truncate to empty
          newData = new Uint8Array(0);
        } else if (length >= srcStat.size) {
          // Extend with zeros
          const existingData = syncFs.readFileSync(match.relativePath);
          newData = new Uint8Array(length);
          newData.set(existingData, 0);
        } else {
          // Truncate to smaller size
          const existingData = syncFs.readFileSync(match.relativePath);
          newData = existingData.slice(0, length);
        }
        syncFs.writeFileSync(match.relativePath, newData);
      }
      return;
    }
  }
  return realFs.truncate(path, len);
}

export async function symlink(
  target: Parameters<typeof realFs.symlink>[0],
  path: Parameters<typeof realFs.symlink>[1],
  type?: Parameters<typeof realFs.symlink>[2]
): Promise<void> {
  const pathStr = getPath(path);
  const targetStr = getPath(target);

  if (pathStr && targetStr) {
    const match = findMount(pathStr);
    if (match) {
      const asyncFs = getAsyncFs(match);
      const syncFs = getSyncFs(match);

      if (asyncFs) {
        if (!asyncFs.symlink) {
          throw createFsError('ENOSYS', 'symlink', pathStr, 'symlink not supported');
        }
        return asyncFs.symlink(match.relativePath, targetStr);
      } else if (syncFs) {
        if (!syncFs.symlinkSync) {
          throw createFsError('ENOSYS', 'symlink', pathStr, 'symlink not supported');
        }
        return syncFs.symlinkSync(match.relativePath, targetStr);
      } else {
        throw createFsError('ENOSYS', 'symlink', pathStr, 'Filesystem does not support symlink');
      }
    }
  }
  return realFs.symlink(target, path, type);
}

export async function readlink(
  path: Parameters<typeof realFs.readlink>[0],
  options?: Parameters<typeof realFs.readlink>[1]
): Promise<string | Buffer> {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      const asyncFs = getAsyncFs(match);
      const syncFs = getSyncFs(match);

      let target: string;
      if (asyncFs) {
        if (!asyncFs.readlink) {
          throw createFsError('ENOSYS', 'readlink', pathStr, 'readlink not supported');
        }
        target = await asyncFs.readlink(match.relativePath);
      } else if (syncFs) {
        if (!syncFs.readlinkSync) {
          throw createFsError('ENOSYS', 'readlink', pathStr, 'readlink not supported');
        }
        target = syncFs.readlinkSync(match.relativePath);
      } else {
        throw createFsError('ENOSYS', 'readlink', pathStr, 'Filesystem does not support readlink');
      }

      const encoding =
        typeof options === 'string'
          ? options
          : typeof options === 'object' && options !== null
            ? options.encoding
            : undefined;

      if (encoding === 'buffer') {
        return Buffer.from(target);
      }
      return target;
    }
  }
  return realFs.readlink(path, options) as Promise<string | Buffer>;
}

export async function realpath(
  path: Parameters<typeof realFs.realpath>[0],
  options?: Parameters<typeof realFs.realpath>[1]
): Promise<string | Buffer> {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      const encoding =
        typeof options === 'string'
          ? options
          : typeof options === 'object' && options !== null
            ? options.encoding
            : undefined;

      if ((encoding as string) === 'buffer') {
        return Buffer.from(pathStr);
      }
      return pathStr;
    }
  }
  return realFs.realpath(path, options) as Promise<string | Buffer>;
}

export async function utimes(
  path: Parameters<typeof realFs.utimes>[0],
  atime: Parameters<typeof realFs.utimes>[1],
  mtime: Parameters<typeof realFs.utimes>[2]
): Promise<void> {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      const asyncFs = getAsyncFs(match);
      const syncFs = getSyncFs(match);

      // utimes is not supported on mounted filesystems
      // Just verify the file exists
      let s: Stat | null;
      if (asyncFs) {
        s = await asyncFs.stat(match.relativePath);
      } else if (syncFs) {
        s = syncFs.statSync(match.relativePath);
      } else {
        throw createFsError('ENOSYS', 'utimes', pathStr, 'Filesystem does not support stat');
      }

      if (!s) {
        throw createFsError('ENOENT', 'utimes', pathStr);
      }
      return;
    }
  }
  return realFs.utimes(path, atime, mtime);
}

// Re-export functions we don't need to wrap
export const chmod = realFs.chmod;
export const chown = realFs.chown;
export const lchmod = realFs.lchmod;
export const lchown = realFs.lchown;
export const lutimes = realFs.lutimes;
export const link = realFs.link;
export const open = realFs.open;
export const opendir = realFs.opendir;
export const mkdtemp = realFs.mkdtemp;
export const watch = realFs.watch;
export const constants = realFs.constants;

// Default export for `import fs from 'node:fs/promises'` style imports
export default {
  readFile,
  writeFile,
  appendFile,
  stat,
  lstat,
  readdir,
  mkdir,
  rm,
  rmdir,
  unlink,
  rename,
  copyFile,
  cp,
  access,
  truncate,
  symlink,
  readlink,
  realpath,
  utimes,
  chmod,
  chown,
  lchmod,
  lchown,
  lutimes,
  link,
  open,
  opendir,
  mkdtemp,
  watch,
  constants,
};
