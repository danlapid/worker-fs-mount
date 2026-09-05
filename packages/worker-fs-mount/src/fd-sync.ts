import { Buffer } from 'node:buffer';
import type { BigIntStats, PathLike, Stats } from 'node:fs';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
// Use the unaliased builtin for descriptors opened outside mounted volumes.
// biome-ignore lint/style/useNodejsImportProtocol: avoid the node:fs alias loop
import * as realFs from 'fs';
import { findMount, getMountRegistry, getSyncFs } from './registry.js';
import { toNodeStats } from './stats.js';
import type { SyncFileHandle, SyncOpenOptions } from './types.js';

type Descriptor = { file: SyncFileHandle; position: number; append: boolean };
const FIRST_FD = 0x40000000;
let nextFd = FIRST_FD;
const scopes = new WeakMap<object, Map<number, Descriptor>>();

export function isVirtualFd(fd: number): boolean {
  return fd >= FIRST_FD;
}

function table(): Map<number, Descriptor> {
  const scope = getMountRegistry();
  let descriptors = scopes.get(scope);
  if (!descriptors) {
    descriptors = new Map();
    scopes.set(scope, descriptors);
  }
  return descriptors;
}

function fail(code: string, syscall: string): never {
  throw Object.assign(new Error(`${code}: ${syscall}`), { code, syscall });
}

function descriptor(fd: number, syscall: string): Descriptor {
  const result = table().get(fd);
  if (!result) fail('EBADF', syscall);
  return result;
}

function integer(value: number, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw Object.assign(new RangeError(`${name} is out of range`), { code: 'ERR_OUT_OF_RANGE' });
  }
  return value;
}

function permissionMode(mode: number | string): number {
  if (typeof mode === 'string' && !/^[0-7]+$/.test(mode)) fail('ERR_INVALID_ARG_VALUE', 'mode');
  return integer(typeof mode === 'string' ? Number.parseInt(mode, 8) : mode, 'mode', 0o7777);
}

function options(flags: string | number, mode: number | string): SyncOpenOptions {
  const c = realFs.constants;
  if (typeof flags === 'string') {
    const flagMap: Record<string, number> = {
      r: c.O_RDONLY,
      'r+': c.O_RDWR,
      rs: c.O_RDONLY | c.O_SYNC,
      'rs+': c.O_RDWR | c.O_SYNC,
      w: c.O_WRONLY | c.O_CREAT | c.O_TRUNC,
      wx: c.O_WRONLY | c.O_CREAT | c.O_TRUNC | c.O_EXCL,
      'w+': c.O_RDWR | c.O_CREAT | c.O_TRUNC,
      'wx+': c.O_RDWR | c.O_CREAT | c.O_TRUNC | c.O_EXCL,
      a: c.O_WRONLY | c.O_CREAT | c.O_APPEND,
      ax: c.O_WRONLY | c.O_CREAT | c.O_APPEND | c.O_EXCL,
      'a+': c.O_RDWR | c.O_CREAT | c.O_APPEND,
      'ax+': c.O_RDWR | c.O_CREAT | c.O_APPEND | c.O_EXCL,
      as: c.O_WRONLY | c.O_CREAT | c.O_APPEND | c.O_SYNC,
      'as+': c.O_RDWR | c.O_CREAT | c.O_APPEND | c.O_SYNC,
    };
    const normalized = flags.replace(/^xw/, 'wx').replace(/^xa/, 'ax');
    const numeric = flagMap[normalized];
    if (numeric === undefined) fail('ERR_INVALID_ARG_VALUE', 'open');
    flags = numeric;
  }
  integer(flags, 'flags', 0x7fffffff);
  const access = flags & 3;
  if (access === 3) fail('EINVAL', 'open');
  const permissions = permissionMode(mode);
  return {
    read: access !== c.O_WRONLY,
    write: access !== c.O_RDONLY,
    create: Boolean(flags & c.O_CREAT),
    exclusive: Boolean(flags & c.O_EXCL),
    truncate: Boolean(flags & c.O_TRUNC),
    append: Boolean(flags & c.O_APPEND),
    noFollow: Boolean(flags & c.O_NOFOLLOW),
    directory: Boolean(flags & c.O_DIRECTORY),
    mode: permissions,
  };
}

export function openSync(
  path: PathLike,
  flags: string | number,
  mode: number | string = 0o666
): number {
  const value =
    typeof path === 'string' ? path : Buffer.isBuffer(path) ? path.toString() : fileURLToPath(path);
  if (value.includes('\0')) fail('ERR_INVALID_ARG_VALUE', 'open');
  const match = findMount(posix.resolve(value));
  if (!match) return realFs.openSync(path, flags, mode);
  const fs = getSyncFs(match);
  // RPC stubs synthesize callable properties for absent methods; they cannot open synchronously.
  let owner: object | null = fs;
  while (owner && !Object.getOwnPropertyNames(owner).includes('openFileSync')) {
    owner = Object.getPrototypeOf(owner);
  }
  if (!owner || !fs?.openFileSync) fail('ENOSYS', 'open');
  if (nextFd > 0x7fffffff) fail('EMFILE', 'open');
  const opts = options(flags, mode);
  const file = fs.openFileSync(match.relativePath, opts);
  const fd = nextFd++;
  table().set(fd, { file, position: 0, append: opts.append ?? false });
  return fd;
}

export function closeSync(fd: number): void {
  if (!isVirtualFd(fd)) {
    realFs.closeSync(fd);
    return;
  }
  descriptor(fd, 'close').file.close();
  table().delete(fd);
}

type IOOptions = { offset?: number; length?: number; position?: number | null };
function range(
  buffer: NodeJS.ArrayBufferView,
  offset: number | IOOptions | undefined,
  length: number | undefined,
  position: number | null | undefined
) {
  if (!ArrayBuffer.isView(buffer)) fail('ERR_INVALID_ARG_TYPE', 'buffer');
  const opts = typeof offset === 'object' ? offset : { offset, length, position };
  const start = integer(opts.offset ?? 0, 'offset', buffer.byteLength);
  const count = integer(
    opts.length ?? buffer.byteLength - start,
    'length',
    buffer.byteLength - start
  );
  const at = opts.position ?? null;
  if (at !== null) integer(at, 'position');
  return { bytes: new Uint8Array(buffer.buffer, buffer.byteOffset + start, count), at };
}

export function readSync(
  fd: number,
  buffer: NodeJS.ArrayBufferView,
  offset?: number | IOOptions,
  length?: number,
  position?: number | null
): number {
  const { bytes, at } = range(buffer, offset, length, position);
  if (!isVirtualFd(fd)) return realFs.readSync(fd, bytes, 0, bytes.byteLength, at);
  const d = descriptor(fd, 'read');
  const count = d.file.read(bytes, at ?? d.position);
  if (at === null) d.position += count;
  return count;
}

export function writeSync(
  fd: number,
  buffer: NodeJS.ArrayBufferView,
  offset?: number | IOOptions,
  length?: number,
  position?: number | null
): number;
export function writeSync(
  fd: number,
  buffer: string,
  position?: number | null,
  encoding?: BufferEncoding
): number;
export function writeSync(
  fd: number,
  buffer: NodeJS.ArrayBufferView | string,
  offset?: number | null | IOOptions,
  length?: number | BufferEncoding,
  position?: number | null
): number {
  let bytes: Uint8Array, at: number | null;
  if (typeof buffer === 'string') {
    bytes = Buffer.from(buffer, typeof length === 'string' ? length : 'utf8');
    at = typeof offset === 'number' ? integer(offset, 'position') : null;
  } else {
    ({ bytes, at } = range(
      buffer,
      offset ?? undefined,
      typeof length === 'number' ? length : undefined,
      position
    ));
  }
  if (!isVirtualFd(fd)) return realFs.writeSync(fd, bytes, 0, bytes.byteLength, at);
  const d = descriptor(fd, 'write');
  integer((d.append ? d.file.stat().size : (at ?? d.position)) + bytes.length, 'position + length');
  const count = d.file.write(bytes, at ?? d.position);
  if (at === null) d.position = d.append ? d.file.stat().size : d.position + count;
  return count;
}

export function fstatSync(fd: number, options: { bigint: true }): BigIntStats;
export function fstatSync(fd: number, options?: { bigint?: false }): Stats;
export function fstatSync(fd: number, options?: { bigint?: boolean }): Stats | BigIntStats;
export function fstatSync(fd: number, options?: { bigint?: boolean }): Stats | BigIntStats {
  if (!isVirtualFd(fd)) return realFs.fstatSync(fd, options);
  const stat = toNodeStats(descriptor(fd, 'fstat').file.stat());
  if (!options?.bigint) return stat;
  return {
    ...stat,
    dev: BigInt(stat.dev),
    ino: BigInt(stat.ino),
    mode: BigInt(stat.mode),
    nlink: BigInt(stat.nlink),
    uid: BigInt(stat.uid),
    gid: BigInt(stat.gid),
    rdev: BigInt(stat.rdev),
    size: BigInt(stat.size),
    blksize: BigInt(stat.blksize),
    blocks: BigInt(stat.blocks),
    atimeMs: BigInt(stat.atimeMs),
    mtimeMs: BigInt(stat.mtimeMs),
    ctimeMs: BigInt(stat.ctimeMs),
    birthtimeMs: BigInt(stat.birthtimeMs),
    atimeNs: BigInt(stat.atimeMs) * 1000000n,
    mtimeNs: BigInt(stat.mtimeMs) * 1000000n,
    ctimeNs: BigInt(stat.ctimeMs) * 1000000n,
    birthtimeNs: BigInt(stat.birthtimeMs) * 1000000n,
  };
}

export function ftruncateSync(fd: number, length = 0): void {
  if (!isVirtualFd(fd)) {
    realFs.ftruncateSync(fd, length);
    return;
  }
  descriptor(fd, 'ftruncate').file.truncate(integer(length, 'length'));
}

export function fsyncSync(fd: number): void {
  if (!isVirtualFd(fd)) {
    realFs.fsyncSync(fd);
    return;
  }
  descriptor(fd, 'fsync').file.sync();
}

export function fdatasyncSync(fd: number): void {
  if (!isVirtualFd(fd)) {
    realFs.fdatasyncSync(fd);
    return;
  }
  descriptor(fd, 'fdatasync').file.sync();
}

export function fchmodSync(fd: number, mode: number | string): void {
  if (!isVirtualFd(fd)) {
    realFs.fchmodSync(fd, mode);
    return;
  }
  const file = descriptor(fd, 'fchmod').file;
  if (!file.chmod) fail('ENOSYS', 'fchmod');
  file.chmod(permissionMode(mode));
}

export function readDescriptor(
  fd: number,
  options?: Parameters<typeof realFs.readFileSync>[1]
): Buffer | string {
  const chunks: Buffer[] = [];
  for (;;) {
    const buffer = Buffer.alloc(64 * 1024);
    const count = readSync(fd, buffer);
    if (!count) break;
    chunks.push(buffer.subarray(0, count));
  }
  const bytes = Buffer.concat(chunks);
  const encoding = typeof options === 'string' ? options : options?.encoding;
  return encoding ? bytes.toString(encoding) : bytes;
}

export function writeDescriptor(
  fd: number,
  data: Parameters<typeof realFs.writeFileSync>[1],
  options?: Parameters<typeof realFs.writeFileSync>[2]
): void {
  const encoding = typeof options === 'string' ? options : options?.encoding;
  const bytes =
    typeof data === 'string'
      ? Buffer.from(data, encoding ?? 'utf8')
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  do {
    const count = writeSync(fd, bytes, offset, bytes.length - offset);
    if (!count && offset < bytes.length) fail('EIO', 'writeFile');
    offset += count;
  } while (offset < bytes.length);
  if (typeof options === 'object' && options?.flush) fsyncSync(fd);
}
