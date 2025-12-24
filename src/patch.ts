/**
 * Monkey-patches node:fs/promises to intercept calls and redirect
 * mounted paths to their WorkerFilesystem implementations.
 *
 * This module is imported for side effects in index.ts.
 */

import * as nodeFs from 'node:fs/promises';
import type { Stats, Dirent, BigIntStats } from 'node:fs';
import { Buffer } from 'node:buffer';
import { findMount } from './registry.js';
import type { DirEntry, Stat } from './types.js';

// Type for the mutable fs module - we need to bypass readonly
const fs = nodeFs as Record<string, unknown>;

// Store original implementations
const originals = {
  readFile: nodeFs.readFile,
  writeFile: nodeFs.writeFile,
  appendFile: nodeFs.appendFile,
  stat: nodeFs.stat,
  lstat: nodeFs.lstat,
  readdir: nodeFs.readdir,
  mkdir: nodeFs.mkdir,
  rm: nodeFs.rm,
  rmdir: nodeFs.rmdir,
  unlink: nodeFs.unlink,
  rename: nodeFs.rename,
  copyFile: nodeFs.copyFile,
  cp: nodeFs.cp,
  access: nodeFs.access,
  truncate: nodeFs.truncate,
  symlink: nodeFs.symlink,
  readlink: nodeFs.readlink,
  realpath: nodeFs.realpath,
  utimes: nodeFs.utimes,
} as const;

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

  // Create a Stats-like object
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

// === Patched Functions ===

fs['readFile'] = async function readFile(
  path: Parameters<typeof nodeFs.readFile>[0],
  options?: Parameters<typeof nodeFs.readFile>[1]
): Promise<Buffer | string> {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      const data = await match.mount.stub.readFile(match.relativePath);
      const buffer = Buffer.from(data);

      // Handle encoding option
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
  return originals.readFile(path, options) as Promise<Buffer | string>;
};

fs['writeFile'] = async function writeFile(
  path: Parameters<typeof nodeFs.writeFile>[0],
  data: Parameters<typeof nodeFs.writeFile>[1],
  options?: Parameters<typeof nodeFs.writeFile>[2]
): Promise<void> {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      // Convert data to Uint8Array
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
        // Iterable<string | Uint8Array> or AsyncIterable - collect chunks
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

      // Determine flags
      const flag =
        typeof options === 'object' && options !== null ? options.flag : undefined;

      await match.mount.stub.writeFile(match.relativePath, bytes, {
        append: flag === 'a' || flag === 'a+',
        exclusive: flag === 'wx' || flag === 'xw',
      });
      return;
    }
  }
  return originals.writeFile(path, data, options);
};

fs['appendFile'] = async function appendFile(
  path: Parameters<typeof nodeFs.appendFile>[0],
  data: Parameters<typeof nodeFs.appendFile>[1],
  options?: Parameters<typeof nodeFs.appendFile>[2]
): Promise<void> {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      // Convert data to Uint8Array
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
  return originals.appendFile(path, data, options);
};

fs['stat'] = async function stat(
  path: Parameters<typeof nodeFs.stat>[0],
  options?: Parameters<typeof nodeFs.stat>[1]
): Promise<Stats | BigIntStats> {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      const s = await match.mount.stub.stat(match.relativePath, { followSymlinks: true });
      if (!s) {
        throw createFsError('ENOENT', 'stat', pathStr);
      }
      // Note: bigint option not supported for mounted paths
      return toNodeStats(s);
    }
  }
  return originals.stat(path, options) as Promise<Stats | BigIntStats>;
};

fs['lstat'] = async function lstat(
  path: Parameters<typeof nodeFs.lstat>[0],
  options?: Parameters<typeof nodeFs.lstat>[1]
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
  return originals.lstat(path, options) as Promise<Stats | BigIntStats>;
};

fs['readdir'] = async function readdir(
  path: Parameters<typeof nodeFs.readdir>[0],
  options?: Parameters<typeof nodeFs.readdir>[1]
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
  return originals.readdir(path, options as any) as Promise<string[] | Buffer[] | Dirent[]>;
};

fs['mkdir'] = async function mkdir(
  path: Parameters<typeof nodeFs.mkdir>[0],
  options?: Parameters<typeof nodeFs.mkdir>[1]
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
  return originals.mkdir(path, options) as Promise<string | undefined>;
};

fs['rm'] = async function rm(
  path: Parameters<typeof nodeFs.rm>[0],
  options?: Parameters<typeof nodeFs.rm>[1]
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
  return originals.rm(path, options);
};

fs['rmdir'] = async function rmdir(
  path: Parameters<typeof nodeFs.rmdir>[0],
  options?: Parameters<typeof nodeFs.rmdir>[1]
): Promise<void> {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      // rmdir only works on empty directories
      return match.mount.stub.rm(match.relativePath, { recursive: false, force: false });
    }
  }
  return originals.rmdir(path, options);
};

fs['unlink'] = async function unlink(
  path: Parameters<typeof nodeFs.unlink>[0]
): Promise<void> {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      return match.mount.stub.unlink(match.relativePath);
    }
  }
  return originals.unlink(path);
};

fs['rename'] = async function rename(
  oldPath: Parameters<typeof nodeFs.rename>[0],
  newPath: Parameters<typeof nodeFs.rename>[1]
): Promise<void> {
  const oldPathStr = getPath(oldPath);
  const newPathStr = getPath(newPath);

  if (oldPathStr && newPathStr) {
    const oldMatch = findMount(oldPathStr);
    const newMatch = findMount(newPathStr);

    // Check if paths are on different mounts
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

  return originals.rename(oldPath, newPath);
};

fs['copyFile'] = async function copyFile(
  src: Parameters<typeof nodeFs.copyFile>[0],
  dest: Parameters<typeof nodeFs.copyFile>[1],
  mode?: Parameters<typeof nodeFs.copyFile>[2]
): Promise<void> {
  const srcStr = getPath(src);
  const destStr = getPath(dest);

  if (srcStr && destStr) {
    const srcMatch = findMount(srcStr);
    const destMatch = findMount(destStr);

    // If either path is mounted, handle it ourselves
    if (srcMatch || destMatch) {
      // Read from source
      let data: Uint8Array;
      if (srcMatch) {
        data = await srcMatch.mount.stub.readFile(srcMatch.relativePath);
      } else {
        const buffer = await originals.readFile(src);
        data = new Uint8Array(buffer);
      }

      // Write to destination
      if (destMatch) {
        await destMatch.mount.stub.writeFile(destMatch.relativePath, data);
      } else {
        await originals.writeFile(dest, data);
      }
      return;
    }
  }

  return originals.copyFile(src, dest, mode);
};

fs['cp'] = async function cp(
  src: Parameters<typeof nodeFs.cp>[0],
  dest: Parameters<typeof nodeFs.cp>[1],
  options?: Parameters<typeof nodeFs.cp>[2]
): Promise<void> {
  const srcStr = getPath(src);
  const destStr = getPath(dest);

  if (srcStr && destStr) {
    const srcMatch = findMount(srcStr);
    const destMatch = findMount(destStr);

    // If both are on the same mount and it supports cp, use it
    if (srcMatch && destMatch && srcMatch.mount === destMatch.mount) {
      if (srcMatch.mount.stub.cp) {
        const recursive = options?.recursive === true;
        return srcMatch.mount.stub.cp(srcMatch.relativePath, destMatch.relativePath, {
          recursive,
        });
      }
    }

    // Otherwise, fall back to reading and writing
    if (srcMatch || destMatch) {
      // Get source stat to check if it's a directory
      let isDirectory = false;
      if (srcMatch) {
        const srcStat = await srcMatch.mount.stub.stat(srcMatch.relativePath);
        isDirectory = srcStat?.type === 'directory';
      } else {
        const srcStat = await originals.stat(src);
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

      // Read from source
      let data: Uint8Array;
      if (srcMatch) {
        data = await srcMatch.mount.stub.readFile(srcMatch.relativePath);
      } else {
        const buffer = await originals.readFile(src);
        data = new Uint8Array(buffer);
      }

      // Write to destination
      if (destMatch) {
        await destMatch.mount.stub.writeFile(destMatch.relativePath, data);
      } else {
        await originals.writeFile(dest, data);
      }
      return;
    }
  }

  return originals.cp(src, dest, options);
};

fs['access'] = async function access(
  path: Parameters<typeof nodeFs.access>[0],
  mode?: Parameters<typeof nodeFs.access>[1]
): Promise<void> {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      if (match.mount.stub.access) {
        return match.mount.stub.access(match.relativePath, mode);
      }
      // Fallback: use stat to check existence
      const s = await match.mount.stub.stat(match.relativePath);
      if (!s) {
        throw createFsError('ENOENT', 'access', pathStr);
      }
      return;
    }
  }
  return originals.access(path, mode);
};

fs['truncate'] = async function truncate(
  path: Parameters<typeof nodeFs.truncate>[0],
  len?: Parameters<typeof nodeFs.truncate>[1]
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
  return originals.truncate(path, len);
};

fs['symlink'] = async function symlink(
  target: Parameters<typeof nodeFs.symlink>[0],
  path: Parameters<typeof nodeFs.symlink>[1],
  type?: Parameters<typeof nodeFs.symlink>[2]
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
  return originals.symlink(target, path, type);
};

fs['readlink'] = async function readlink(
  path: Parameters<typeof nodeFs.readlink>[0],
  options?: Parameters<typeof nodeFs.readlink>[1]
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
  return originals.readlink(path, options) as Promise<string | Buffer>;
};

fs['realpath'] = async function realpath(
  path: Parameters<typeof nodeFs.realpath>[0],
  options?: Parameters<typeof nodeFs.realpath>[1]
): Promise<string | Buffer> {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      // For mounted paths, we just return the normalized path
      // since we don't have a real filesystem to resolve against
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
  return originals.realpath(path, options) as Promise<string | Buffer>;
};

fs['utimes'] = async function utimes(
  path: Parameters<typeof nodeFs.utimes>[0],
  atime: Parameters<typeof nodeFs.utimes>[1],
  mtime: Parameters<typeof nodeFs.utimes>[2]
): Promise<void> {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      if (!match.mount.stub.setLastModified) {
        throw createFsError('ENOSYS', 'utimes', pathStr, 'utimes not supported');
      }
      // Convert mtime to Date
      const mtimeDate =
        typeof mtime === 'number'
          ? new Date(mtime * 1000)
          : typeof mtime === 'string'
            ? new Date(mtime)
            : mtime;
      return match.mount.stub.setLastModified(match.relativePath, mtimeDate);
    }
  }
  return originals.utimes(path, atime, mtime);
};
