import type { Stats as NodeStats } from 'node:fs';
import type { Stat } from './types.js';

export function toNodeStats(s: Stat): NodeStats {
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
    ino: s.ino ?? 0,
    mode:
      (isDir ? 0o040000 : isSymlink ? 0o120000 : 0o100000) |
      ((s.mode ?? (isDir ? 0o755 : 0o644)) & 0o7777),
    nlink: s.nlink ?? 1,
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
