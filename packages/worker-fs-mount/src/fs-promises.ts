/**
 * Replacement module for node:fs/promises that routes mounted paths
 * to their WorkerFilesystem implementations.
 *
 * Users should alias this in their wrangler.toml:
 *
 * [alias]
 * "node:fs/promises" = "worker-fs-mount/fs"
 */

// Import the SYNC fs module and use .promises to avoid alias loop
import * as nodeFs from 'node:fs';
import type { Stats, Dirent, BigIntStats } from 'node:fs';
import { Buffer } from 'node:buffer';
import { findMount } from './registry.js';
import type { DirEntry, Stat } from './types.js';

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

// === Wrapped Functions ===

export async function readFile(
  path: Parameters<typeof realFs.readFile>[0],
  options?: Parameters<typeof realFs.readFile>[1]
): Promise<Buffer | string> {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      const data = await match.mount.stub.readFile(match.relativePath);
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

      await match.mount.stub.writeFile(match.relativePath, bytes, {
        append: flag === 'a' || flag === 'a+',
        exclusive: flag === 'wx' || flag === 'xw',
      });
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

      await match.mount.stub.writeFile(match.relativePath, bytes, { append: true });
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
      const s = await match.mount.stub.stat(match.relativePath, { followSymlinks: true });
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
      const s = await match.mount.stub.stat(match.relativePath, { followSymlinks: false });
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
      const entries = await match.mount.stub.readdir(match.relativePath, { recursive });

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
      return match.mount.stub.mkdir(match.relativePath, { recursive });
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
      return match.mount.stub.rm(match.relativePath, { recursive, force });
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
      return match.mount.stub.rm(match.relativePath, { recursive: false, force: false });
    }
  }
  return (realFs.rmdir as any)(path, options);
}

export async function unlink(path: Parameters<typeof realFs.unlink>[0]): Promise<void> {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      return match.mount.stub.unlink(match.relativePath);
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

    if (oldMatch?.mount !== newMatch?.mount) {
      throw createFsError('EXDEV', 'rename', oldPathStr, 'Cross-mount rename not supported');
    }

    if (oldMatch && newMatch) {
      if (!oldMatch.mount.stub.rename) {
        throw createFsError('ENOSYS', 'rename', oldPathStr, 'rename not supported');
      }
      return oldMatch.mount.stub.rename(oldMatch.relativePath, newMatch.relativePath);
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
      let data: Uint8Array;
      if (srcMatch) {
        data = await srcMatch.mount.stub.readFile(srcMatch.relativePath);
      } else {
        const buffer = await realFs.readFile(src);
        data = new Uint8Array(buffer);
      }

      if (destMatch) {
        await destMatch.mount.stub.writeFile(destMatch.relativePath, data);
      } else {
        await realFs.writeFile(dest, data);
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

    if (srcMatch && destMatch && srcMatch.mount === destMatch.mount) {
      if (srcMatch.mount.stub.cp) {
        const recursive = options?.recursive === true;
        return srcMatch.mount.stub.cp(srcMatch.relativePath, destMatch.relativePath, {
          recursive,
        });
      }
    }

    if (srcMatch || destMatch) {
      let isDirectory = false;
      if (srcMatch) {
        const srcStat = await srcMatch.mount.stub.stat(srcMatch.relativePath);
        isDirectory = srcStat?.type === 'directory';
      } else {
        const srcStat = await realFs.stat(src as any);
        isDirectory = srcStat.isDirectory();
      }

      if (isDirectory) {
        throw createFsError(
          'EISDIR',
          'cp',
          srcStr,
          'Directory copy across mounts not yet implemented'
        );
      }

      let data: Uint8Array;
      if (srcMatch) {
        data = await srcMatch.mount.stub.readFile(srcMatch.relativePath);
      } else {
        const buffer = await realFs.readFile(src as any);
        data = new Uint8Array(buffer);
      }

      if (destMatch) {
        await destMatch.mount.stub.writeFile(destMatch.relativePath, data);
      } else {
        await realFs.writeFile(dest as any, data);
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
      if (match.mount.stub.access) {
        return match.mount.stub.access(match.relativePath, mode);
      }
      const s = await match.mount.stub.stat(match.relativePath);
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
      if (!match.mount.stub.truncate) {
        throw createFsError('ENOSYS', 'truncate', pathStr, 'truncate not supported');
      }
      return match.mount.stub.truncate(match.relativePath, len ?? 0);
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
      if (!match.mount.stub.symlink) {
        throw createFsError('ENOSYS', 'symlink', pathStr, 'symlink not supported');
      }
      return match.mount.stub.symlink(match.relativePath, targetStr);
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
      if (!match.mount.stub.readlink) {
        throw createFsError('ENOSYS', 'readlink', pathStr, 'readlink not supported');
      }
      const target = await match.mount.stub.readlink(match.relativePath);

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
      if (!match.mount.stub.setLastModified) {
        throw createFsError('ENOSYS', 'utimes', pathStr, 'utimes not supported');
      }
      const mtimeDate =
        typeof mtime === 'number'
          ? new Date(mtime * 1000)
          : typeof mtime === 'string'
            ? new Date(mtime)
            : mtime;
      return match.mount.stub.setLastModified(match.relativePath, mtimeDate);
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
