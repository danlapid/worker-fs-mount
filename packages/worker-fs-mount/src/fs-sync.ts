/**
 * Replacement module for node:fs sync methods that routes mounted paths
 * to their SyncWorkerFilesystem implementations.
 *
 * Users should alias this in their wrangler.toml:
 *
 * [alias]
 * "node:fs" = "worker-fs-mount/fs-sync"
 *
 * This module provides synchronous filesystem operations for mounted paths
 * that implement the SyncWorkerFilesystem interface.
 *
 * IMPORTANT: Sync methods only work on mounts that implement SyncWorkerFilesystem.
 * Calling sync methods on async-only mounts will throw an error.
 */

import { Buffer } from 'node:buffer';
import type { Dirent as NodeDirent, Stats as NodeStats } from 'node:fs';
// IMPORTANT: Use 'fs' not 'node:fs' to avoid wrangler alias loop
// Wrangler aliases are exact string matches, so 'fs' won't be caught
import * as realFs from 'fs';
import { findMount, getSyncFs } from './registry.js';
import type { DirEntry, Stat, SyncWorkerFilesystem } from './types.js';

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
function toNodeStats(s: Stat): NodeStats {
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

  return stats as NodeStats;
}

/**
 * Convert our DirEntry to a Node.js Dirent-like object.
 */
function toNodeDirent(entry: DirEntry, parentPath: string): NodeDirent {
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

  return dirent as NodeDirent;
}

/**
 * Helper for recursive directory copy (sync).
 */
function copyDirectorySync(
  syncFs: SyncWorkerFilesystem,
  srcPath: string,
  destPath: string
): void {
  syncFs.mkdirSync(destPath, { recursive: true });
  const entries = syncFs.readdirSync(srcPath);

  for (const entry of entries) {
    const srcChildPath = srcPath === '/' ? `/${entry.name}` : `${srcPath}/${entry.name}`;
    const destChildPath = destPath === '/' ? `/${entry.name}` : `${destPath}/${entry.name}`;

    if (entry.type === 'directory') {
      copyDirectorySync(syncFs, srcChildPath, destChildPath);
    } else if (entry.type === 'file') {
      const data = syncFs.readFileSync(srcChildPath);
      syncFs.writeFileSync(destChildPath, data);
    } else if (entry.type === 'symlink' && syncFs.readlinkSync && syncFs.symlinkSync) {
      const target = syncFs.readlinkSync(srcChildPath);
      syncFs.symlinkSync(destChildPath, target);
    }
  }
}

// === Sync File Operations ===

export function readFileSync(
  path: Parameters<typeof realFs.readFileSync>[0],
  options?: Parameters<typeof realFs.readFileSync>[1]
): Buffer | string {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      const syncFs = getSyncFs(match);
      if (!syncFs) {
        throw createFsError(
          'ENOSYS',
          'readFileSync',
          pathStr,
          'Filesystem does not support sync operations'
        );
      }

      const data = syncFs.readFileSync(match.relativePath);
      const buffer = Buffer.from(data);

      const encoding =
        typeof options === 'string'
          ? options
          : typeof options === 'object' && options !== null
            ? options.encoding
            : undefined;

      if (encoding && (encoding as string) !== 'buffer') {
        return buffer.toString(encoding as BufferEncoding);
      }
      return buffer;
    }
  }
  return realFs.readFileSync(path, options);
}

export function writeFileSync(
  path: Parameters<typeof realFs.writeFileSync>[0],
  data: Parameters<typeof realFs.writeFileSync>[1],
  options?: Parameters<typeof realFs.writeFileSync>[2]
): void {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      const syncFs = getSyncFs(match);
      if (!syncFs) {
        throw createFsError(
          'ENOSYS',
          'writeFileSync',
          pathStr,
          'Filesystem does not support sync operations'
        );
      }

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
        throw createFsError('EINVAL', 'writeFileSync', pathStr, 'Invalid data type');
      }

      const flag = typeof options === 'object' && options !== null ? options.flag : undefined;
      const isAppend = flag === 'a' || flag === 'a+';
      const isExclusive = flag === 'wx' || flag === 'xw';

      // Check exclusive flag
      if (isExclusive) {
        const existing = syncFs.statSync(match.relativePath);
        if (existing) {
          throw createFsError('EEXIST', 'writeFileSync', pathStr);
        }
      }

      syncFs.writeFileSync(match.relativePath, bytes, {
        flags: isAppend ? 'a' : 'w',
      });
      return;
    }
  }
  return realFs.writeFileSync(path, data, options);
}

export function appendFileSync(
  path: Parameters<typeof realFs.appendFileSync>[0],
  data: Parameters<typeof realFs.appendFileSync>[1],
  options?: Parameters<typeof realFs.appendFileSync>[2]
): void {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      const syncFs = getSyncFs(match);
      if (!syncFs) {
        throw createFsError(
          'ENOSYS',
          'appendFileSync',
          pathStr,
          'Filesystem does not support sync operations'
        );
      }

      let bytes: Uint8Array;
      if (typeof data === 'string') {
        bytes = new TextEncoder().encode(data);
      } else {
        bytes = new Uint8Array(data);
      }

      syncFs.writeFileSync(match.relativePath, bytes, { flags: 'a' });
      return;
    }
  }
  return realFs.appendFileSync(path, data, options);
}

export function statSync(
  path: Parameters<typeof realFs.statSync>[0],
  options?: Parameters<typeof realFs.statSync>[1]
): NodeStats {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      const syncFs = getSyncFs(match);
      if (!syncFs) {
        throw createFsError(
          'ENOSYS',
          'statSync',
          pathStr,
          'Filesystem does not support sync operations'
        );
      }

      const s = syncFs.statSync(match.relativePath, { followSymlinks: true });
      if (!s) {
        throw createFsError('ENOENT', 'statSync', pathStr);
      }
      return toNodeStats(s);
    }
  }
  return realFs.statSync(path, options) as NodeStats;
}

export function lstatSync(
  path: Parameters<typeof realFs.lstatSync>[0],
  options?: Parameters<typeof realFs.lstatSync>[1]
): NodeStats {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      const syncFs = getSyncFs(match);
      if (!syncFs) {
        throw createFsError(
          'ENOSYS',
          'lstatSync',
          pathStr,
          'Filesystem does not support sync operations'
        );
      }

      const s = syncFs.statSync(match.relativePath, { followSymlinks: false });
      if (!s) {
        throw createFsError('ENOENT', 'lstatSync', pathStr);
      }
      return toNodeStats(s);
    }
  }
  return realFs.lstatSync(path, options) as NodeStats;
}

export function readdirSync(
  path: Parameters<typeof realFs.readdirSync>[0],
  options?: Parameters<typeof realFs.readdirSync>[1]
): string[] | Buffer[] | NodeDirent[] {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      const syncFs = getSyncFs(match);
      if (!syncFs) {
        throw createFsError(
          'ENOSYS',
          'readdirSync',
          pathStr,
          'Filesystem does not support sync operations'
        );
      }

      const opts = typeof options === 'object' && options !== null ? options : {};
      const recursive = 'recursive' in opts ? opts.recursive === true : false;
      const entries = syncFs.readdirSync(match.relativePath, { recursive });

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

      if ((encoding as string) === 'buffer') {
        return entries.map((e) => Buffer.from(e.name));
      }

      return entries.map((e) => e.name);
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return realFs.readdirSync(path, options as any) as string[] | Buffer[] | NodeDirent[];
}

export function mkdirSync(
  path: Parameters<typeof realFs.mkdirSync>[0],
  options?: Parameters<typeof realFs.mkdirSync>[1]
): string | undefined {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      const syncFs = getSyncFs(match);
      if (!syncFs) {
        throw createFsError(
          'ENOSYS',
          'mkdirSync',
          pathStr,
          'Filesystem does not support sync operations'
        );
      }

      const recursive =
        typeof options === 'object' && options !== null && options.recursive === true;
      return syncFs.mkdirSync(match.relativePath, { recursive });
    }
  }
  return realFs.mkdirSync(path, options);
}

export function rmSync(
  path: Parameters<typeof realFs.rmSync>[0],
  options?: Parameters<typeof realFs.rmSync>[1]
): void {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      const syncFs = getSyncFs(match);
      if (!syncFs) {
        throw createFsError(
          'ENOSYS',
          'rmSync',
          pathStr,
          'Filesystem does not support sync operations'
        );
      }

      const recursive = options?.recursive === true;
      const force = options?.force === true;
      return syncFs.rmSync(match.relativePath, { recursive, force });
    }
  }
  return realFs.rmSync(path, options);
}

export function rmdirSync(
  path: Parameters<typeof realFs.rmdirSync>[0],
  options?: { maxRetries?: number; retryDelay?: number }
): void {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      const syncFs = getSyncFs(match);
      if (!syncFs) {
        throw createFsError(
          'ENOSYS',
          'rmdirSync',
          pathStr,
          'Filesystem does not support sync operations'
        );
      }

      return syncFs.rmSync(match.relativePath, { recursive: false, force: false });
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (realFs.rmdirSync as any)(path, options);
}

export function unlinkSync(path: Parameters<typeof realFs.unlinkSync>[0]): void {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      const syncFs = getSyncFs(match);
      if (!syncFs) {
        throw createFsError(
          'ENOSYS',
          'unlinkSync',
          pathStr,
          'Filesystem does not support sync operations'
        );
      }

      const s = syncFs.statSync(match.relativePath);
      if (!s) {
        throw createFsError('ENOENT', 'unlinkSync', pathStr);
      }
      if (s.type === 'directory') {
        throw createFsError('EISDIR', 'unlinkSync', pathStr);
      }

      return syncFs.rmSync(match.relativePath);
    }
  }
  return realFs.unlinkSync(path);
}

export function renameSync(
  oldPath: Parameters<typeof realFs.renameSync>[0],
  newPath: Parameters<typeof realFs.renameSync>[1]
): void {
  const oldPathStr = getPath(oldPath);
  const newPathStr = getPath(newPath);

  if (oldPathStr && newPathStr) {
    const oldMatch = findMount(oldPathStr);
    const newMatch = findMount(newPathStr);

    // Cross-mount rename not supported
    if (oldMatch?.mount !== newMatch?.mount) {
      throw createFsError('EXDEV', 'renameSync', oldPathStr, 'Cross-mount rename not supported');
    }

    if (oldMatch && newMatch) {
      const syncFs = getSyncFs(oldMatch);
      if (!syncFs) {
        throw createFsError(
          'ENOSYS',
          'renameSync',
          oldPathStr,
          'Filesystem does not support sync operations'
        );
      }

      const srcStat = syncFs.statSync(oldMatch.relativePath);
      if (!srcStat) {
        throw createFsError('ENOENT', 'renameSync', oldPathStr);
      }

      if (srcStat.type === 'file') {
        const data = syncFs.readFileSync(oldMatch.relativePath);
        syncFs.writeFileSync(newMatch.relativePath, data);
        syncFs.rmSync(oldMatch.relativePath);
      } else if (srcStat.type === 'directory') {
        copyDirectorySync(syncFs, oldMatch.relativePath, newMatch.relativePath);
        syncFs.rmSync(oldMatch.relativePath, { recursive: true });
      } else if (srcStat.type === 'symlink') {
        if (syncFs.readlinkSync && syncFs.symlinkSync) {
          const target = syncFs.readlinkSync(oldMatch.relativePath);
          syncFs.symlinkSync(newMatch.relativePath, target);
          syncFs.rmSync(oldMatch.relativePath);
        } else {
          throw createFsError(
            'ENOSYS',
            'renameSync',
            oldPathStr,
            'symlink operations not supported'
          );
        }
      }
      return;
    }
  }

  return realFs.renameSync(oldPath, newPath);
}

export function copyFileSync(
  src: Parameters<typeof realFs.copyFileSync>[0],
  dest: Parameters<typeof realFs.copyFileSync>[1],
  mode?: Parameters<typeof realFs.copyFileSync>[2]
): void {
  const srcStr = getPath(src);
  const destStr = getPath(dest);

  if (srcStr && destStr) {
    const srcMatch = findMount(srcStr);
    const destMatch = findMount(destStr);

    if (srcMatch || destMatch) {
      if (srcMatch && destMatch) {
        const srcSyncFs = getSyncFs(srcMatch);
        const destSyncFs = getSyncFs(destMatch);

        if (!srcSyncFs) {
          throw createFsError(
            'ENOSYS',
            'copyFileSync',
            srcStr,
            'Source filesystem does not support sync operations'
          );
        }
        if (!destSyncFs) {
          throw createFsError(
            'ENOSYS',
            'copyFileSync',
            destStr,
            'Destination filesystem does not support sync operations'
          );
        }

        const data = srcSyncFs.readFileSync(srcMatch.relativePath);
        destSyncFs.writeFileSync(destMatch.relativePath, data);
      } else if (srcMatch) {
        const srcSyncFs = getSyncFs(srcMatch);
        if (!srcSyncFs) {
          throw createFsError(
            'ENOSYS',
            'copyFileSync',
            srcStr,
            'Filesystem does not support sync operations'
          );
        }
        const data = srcSyncFs.readFileSync(srcMatch.relativePath);
        realFs.writeFileSync(dest, data);
      } else if (destMatch) {
        const destSyncFs = getSyncFs(destMatch);
        if (!destSyncFs) {
          throw createFsError(
            'ENOSYS',
            'copyFileSync',
            destStr,
            'Filesystem does not support sync operations'
          );
        }
        const buffer = realFs.readFileSync(src);
        destSyncFs.writeFileSync(destMatch.relativePath, new Uint8Array(buffer));
      }
      return;
    }
  }

  return realFs.copyFileSync(src, dest, mode);
}

export function accessSync(
  path: Parameters<typeof realFs.accessSync>[0],
  mode?: Parameters<typeof realFs.accessSync>[1]
): void {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      const syncFs = getSyncFs(match);
      if (!syncFs) {
        throw createFsError(
          'ENOSYS',
          'accessSync',
          pathStr,
          'Filesystem does not support sync operations'
        );
      }

      const s = syncFs.statSync(match.relativePath);
      if (!s) {
        throw createFsError('ENOENT', 'accessSync', pathStr);
      }
      return;
    }
  }
  return realFs.accessSync(path, mode);
}

export function truncateSync(
  path: Parameters<typeof realFs.truncateSync>[0],
  len?: Parameters<typeof realFs.truncateSync>[1]
): void {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      const syncFs = getSyncFs(match);
      if (!syncFs) {
        throw createFsError(
          'ENOSYS',
          'truncateSync',
          pathStr,
          'Filesystem does not support sync operations'
        );
      }

      const length = len ?? 0;
      const srcStat = syncFs.statSync(match.relativePath);
      if (!srcStat) {
        throw createFsError('ENOENT', 'truncateSync', pathStr);
      }
      if (srcStat.type !== 'file') {
        throw createFsError('EISDIR', 'truncateSync', pathStr);
      }

      let newData: Uint8Array;
      if (length === 0) {
        newData = new Uint8Array(0);
      } else if (length >= srcStat.size) {
        const existingData = syncFs.readFileSync(match.relativePath);
        newData = new Uint8Array(length);
        newData.set(existingData, 0);
      } else {
        const existingData = syncFs.readFileSync(match.relativePath);
        newData = existingData.slice(0, length);
      }
      syncFs.writeFileSync(match.relativePath, newData);
      return;
    }
  }
  return realFs.truncateSync(path, len);
}

export function symlinkSync(
  target: Parameters<typeof realFs.symlinkSync>[0],
  path: Parameters<typeof realFs.symlinkSync>[1],
  type?: Parameters<typeof realFs.symlinkSync>[2]
): void {
  const pathStr = getPath(path);
  const targetStr = getPath(target);

  if (pathStr && targetStr) {
    const match = findMount(pathStr);
    if (match) {
      const syncFs = getSyncFs(match);
      if (!syncFs) {
        throw createFsError(
          'ENOSYS',
          'symlinkSync',
          pathStr,
          'Filesystem does not support sync operations'
        );
      }

      if (!syncFs.symlinkSync) {
        throw createFsError('ENOSYS', 'symlinkSync', pathStr, 'symlink not supported');
      }
      return syncFs.symlinkSync(match.relativePath, targetStr);
    }
  }
  return realFs.symlinkSync(target, path, type);
}

export function readlinkSync(
  path: Parameters<typeof realFs.readlinkSync>[0],
  options?: Parameters<typeof realFs.readlinkSync>[1]
): string | Buffer {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      const syncFs = getSyncFs(match);
      if (!syncFs) {
        throw createFsError(
          'ENOSYS',
          'readlinkSync',
          pathStr,
          'Filesystem does not support sync operations'
        );
      }

      if (!syncFs.readlinkSync) {
        throw createFsError('ENOSYS', 'readlinkSync', pathStr, 'readlink not supported');
      }
      const target = syncFs.readlinkSync(match.relativePath);

      const encoding =
        typeof options === 'string'
          ? options
          : typeof options === 'object' && options !== null
            ? options.encoding
            : undefined;

      if ((encoding as string) === 'buffer') {
        return Buffer.from(target);
      }
      return target;
    }
  }
  return realFs.readlinkSync(path, options) as string | Buffer;
}

export function realpathSync(
  path: Parameters<typeof realFs.realpathSync>[0],
  options?: Parameters<typeof realFs.realpathSync>[1]
): string | Buffer {
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
  return realFs.realpathSync(path, options) as string | Buffer;
}

export function existsSync(path: Parameters<typeof realFs.existsSync>[0]): boolean {
  const pathStr = getPath(path);
  if (pathStr) {
    const match = findMount(pathStr);
    if (match) {
      const syncFs = getSyncFs(match);
      if (!syncFs) {
        // If no sync support, can't check existence synchronously
        return false;
      }

      const s = syncFs.statSync(match.relativePath);
      return s !== null;
    }
  }
  return realFs.existsSync(path);
}

// Re-export promises from the real fs module
export const promises = realFs.promises;

// Re-export constants
export const constants = realFs.constants;

// Re-export other sync functions that don't need wrapping
export const chmodSync = realFs.chmodSync;
export const chownSync = realFs.chownSync;
export const lchmodSync = realFs.lchmodSync;
export const lchownSync = realFs.lchownSync;
export const lutimesSync = realFs.lutimesSync;
export const linkSync = realFs.linkSync;
export const openSync = realFs.openSync;
export const opendirSync = realFs.opendirSync;
export const mkdtempSync = realFs.mkdtempSync;
export const utimesSync = realFs.utimesSync;
export const closeSync = realFs.closeSync;
export const readSync = realFs.readSync;
export const writeSync = realFs.writeSync;
export const fsyncSync = realFs.fsyncSync;
export const fdatasyncSync = realFs.fdatasyncSync;
export const fstatSync = realFs.fstatSync;
export const ftruncateSync = realFs.ftruncateSync;
export const fchmodSync = realFs.fchmodSync;
export const fchownSync = realFs.fchownSync;
export const futimesSync = realFs.futimesSync;

// Re-export async functions from real fs
export const chmod = realFs.chmod;
export const chown = realFs.chown;
export const close = realFs.close;
export const fchmod = realFs.fchmod;
export const fchown = realFs.fchown;
export const fdatasync = realFs.fdatasync;
export const fstat = realFs.fstat;
export const fsync = realFs.fsync;
export const ftruncate = realFs.ftruncate;
export const futimes = realFs.futimes;
export const lchmod = realFs.lchmod;
export const lchown = realFs.lchown;
export const link = realFs.link;
export const lstat = realFs.lstat;
export const mkdir = realFs.mkdir;
export const mkdtemp = realFs.mkdtemp;
export const open = realFs.open;
export const opendir = realFs.opendir;
export const read = realFs.read;
export const readdir = realFs.readdir;
export const readFile = realFs.readFile;
export const readlink = realFs.readlink;
export const realpath = realFs.realpath;
export const rename = realFs.rename;
export const rm = realFs.rm;
export const rmdir = realFs.rmdir;
export const stat = realFs.stat;
export const symlink = realFs.symlink;
export const truncate = realFs.truncate;
export const unlink = realFs.unlink;
export const utimes = realFs.utimes;
export const watch = realFs.watch;
export const watchFile = realFs.watchFile;
export const unwatchFile = realFs.unwatchFile;
export const write = realFs.write;
export const writeFile = realFs.writeFile;
export const appendFile = realFs.appendFile;
export const access = realFs.access;
export const copyFile = realFs.copyFile;
export const cp = realFs.cp;
export const lutimes = realFs.lutimes;
export const exists = realFs.exists;

// Re-export classes
export const Dirent = realFs.Dirent;
export const Stats = realFs.Stats;
export const ReadStream = realFs.ReadStream;
export const WriteStream = realFs.WriteStream;
export const Dir = realFs.Dir;

// Create streams (re-export)
export const createReadStream = realFs.createReadStream;
export const createWriteStream = realFs.createWriteStream;

// Default export for `import fs from 'node:fs'` style imports
export default {
  // Sync methods (wrapped)
  readFileSync,
  writeFileSync,
  appendFileSync,
  statSync,
  lstatSync,
  readdirSync,
  mkdirSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  renameSync,
  copyFileSync,
  accessSync,
  truncateSync,
  symlinkSync,
  readlinkSync,
  realpathSync,
  existsSync,

  // Sync methods (re-exported)
  chmodSync,
  chownSync,
  lchmodSync,
  lchownSync,
  lutimesSync,
  linkSync,
  openSync,
  opendirSync,
  mkdtempSync,
  utimesSync,
  closeSync,
  readSync,
  writeSync,
  fsyncSync,
  fdatasyncSync,
  fstatSync,
  ftruncateSync,
  fchmodSync,
  fchownSync,
  futimesSync,

  // Async methods (re-exported from real fs)
  chmod,
  chown,
  close,
  fchmod,
  fchown,
  fdatasync,
  fstat,
  fsync,
  ftruncate,
  futimes,
  lchmod,
  lchown,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  read,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  truncate,
  unlink,
  utimes,
  watch,
  watchFile,
  unwatchFile,
  write,
  writeFile,
  appendFile,
  access,
  copyFile,
  cp,
  lutimes,
  exists,

  // Promises API
  promises,

  // Constants
  constants,

  // Classes
  Dirent,
  Stats,
  ReadStream,
  WriteStream,
  Dir,

  // Stream creators
  createReadStream,
  createWriteStream,
};
