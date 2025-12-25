# WorkerFilesystem Mount - NPM Package Specification

## Overview

An npm package (`worker-fs-mount`) that allows Workers to mount a `WorkerEntrypoint` as a virtual filesystem. The package monkey-patches `node:fs/promises` to intercept calls and redirect mounted paths to the entrypoint via jsrpc.

## Installation

```bash
npm install worker-fs-mount
```

## API

### `mount(path, stub)`

```typescript
import { mount } from 'worker-fs-mount';
import fs from 'node:fs/promises';  // Works normally after import!

const handle = mount('/mnt/remote', env.STORAGE_SERVICE);

// node:fs/promises is now mount-aware
await fs.readFile('/mnt/remote/file.txt');  // -> calls stub.readFile()
await fs.readFile('/tmp/local.txt');        // -> uses native fs

// Later:
handle.unmount();
```

**Parameters:**

- `path: string` - The mount point (must start with `/`)
- `stub: WorkerFilesystem` - A WorkerEntrypoint stub (from `ctx.exports`, `env.SERVICE`, or DO stub)

**Returns:** `MountHandle` with `unmount()` method and `path` property.

### How It Works

Importing the package automatically patches `node:fs/promises`. No need to change existing fs imports:

```typescript
// Just import mount - this patches node:fs/promises as a side effect
import { mount } from 'worker-fs-mount';

// Your existing code continues to work
import fs from 'node:fs/promises';
import { readFile } from 'node:fs/promises';

// After mounting, both styles work with mounted paths
mount('/mnt/data', env.STORAGE);
await fs.readFile('/mnt/data/file.txt');      // ✓ works
await readFile('/mnt/data/file.txt');          // ✓ works
```

## Example Usage

```typescript
import { mount } from 'worker-fs-mount';
import fs from 'node:fs/promises';
import { WorkerEntrypoint } from 'cloudflare:workers';

// A simple in-memory filesystem
export class MemoryFS extends WorkerEntrypoint {
  #files = new Map<string, Uint8Array>();

  async stat(path: string) {
    const file = this.#files.get(path);
    if (!file) return null;
    return { type: 'file', size: file.length, writable: true };
  }

  async readFile(path: string) {
    const file = this.#files.get(path);
    if (!file) throw new Error(`ENOENT: ${path}`);
    return file;
  }

  async writeFile(path: string, data: Uint8Array) {
    this.#files.set(path, new Uint8Array(data));
    return data.length;
  }

  async readdir(path: string) {
    const entries = [];
    const prefix = path === '/' ? '/' : path + '/';
    for (const [filePath] of this.#files) {
      if (filePath.startsWith(prefix)) {
        const name = filePath.slice(prefix.length).split('/')[0];
        if (name && !entries.some(e => e.name === name)) {
          entries.push({ name, type: 'file' });
        }
      }
    }
    return entries;
  }

  async mkdir() { /* no-op for in-memory */ }
  async rm(path: string) { this.#files.delete(path); }
  async unlink(path: string) { this.#files.delete(path); }
}

export default class extends WorkerEntrypoint {
  async fetch(request: Request) {
    // Mount the MemoryFS
    const handle = mount('/mnt/mem', this.ctx.exports.MemoryFS);

    try {
      // All fs operations to /mnt/mem/* go through MemoryFS
      await fs.writeFile('/mnt/mem/hello.txt', 'Hello, World!');
      const content = await fs.readFile('/mnt/mem/hello.txt', 'utf8');
      return new Response(content);
    } finally {
      handle.unmount();
    }
  }
}
```

### Mount Sources

```typescript
// Same-worker entrypoint
mount('/mnt/local', ctx.exports.MyFilesystem);

// Service binding
mount('/mnt/remote', env.STORAGE_SERVICE);

// Durable Object stub
const id = env.STORAGE_DO.idFromName('my-storage');
const stub = env.STORAGE_DO.get(id);
mount('/mnt/durable', stub);
```

## WorkerFilesystem Interface

The entrypoint must implement some or all of these methods:

```typescript
interface WorkerFilesystem {
  // Metadata
  stat(path: string, options?: { followSymlinks?: boolean }): Promise<Stat | null>;
  setLastModified?(path: string, mtime: Date): Promise<void>;

  // File operations (whole file)
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array, options?: { append?: boolean; exclusive?: boolean }): Promise<number>;

  // File operations (chunked - for large files)
  read?(path: string, options: { offset: number; length: number }): Promise<Uint8Array>;
  write?(path: string, data: Uint8Array, options: { offset: number }): Promise<number>;

  // File operations (streaming - for very large files)
  createReadStream?(path: string, options?: { start?: number; end?: number }): Promise<ReadableStream<Uint8Array>>;
  createWriteStream?(path: string, options?: { start?: number; flags?: 'w' | 'a' | 'r+' }): Promise<WritableStream<Uint8Array>>;

  // Other file operations
  truncate?(path: string, length?: number): Promise<void>;

  // Directory operations
  readdir(path: string, options?: { recursive?: boolean }): Promise<DirEntry[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;

  // Link operations
  symlink?(linkPath: string, targetPath: string): Promise<void>;
  readlink?(path: string): Promise<string>;
  unlink(path: string): Promise<void>;

  // Copy/move operations
  rename?(oldPath: string, newPath: string): Promise<void>;
  cp?(src: string, dest: string, options?: { recursive?: boolean }): Promise<void>;
}

interface Stat {
  type: 'file' | 'directory' | 'symlink';
  size: number;
  lastModified?: Date;
  created?: Date;
  writable?: boolean;
}

interface DirEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink';
}
```

Methods marked with `?` are optional. If not implemented, operations that require them will throw `ENOSYS`.

## Package Implementation

### Mount Registry

```typescript
// src/registry.ts

interface Mount {
  path: string;
  stub: WorkerFilesystem;
}

const mounts = new Map<string, Mount>();

export function mount(path: string, stub: WorkerFilesystem): MountHandle {
  const normalized = normalizePath(path);

  if (!normalized.startsWith('/')) {
    throw new Error('Mount path must be absolute');
  }

  if (mounts.has(normalized)) {
    throw new Error(`Already mounted: ${normalized}`);
  }

  // Check for overlapping mounts
  for (const existing of mounts.keys()) {
    if (normalized.startsWith(existing + '/') || existing.startsWith(normalized + '/')) {
      throw new Error(`Mount would overlap with: ${existing}`);
    }
  }

  mounts.set(normalized, { path: normalized, stub });

  return {
    path: normalized,
    unmount() {
      mounts.delete(normalized);
    }
  };
}

export function findMount(path: string): { mount: Mount; relativePath: string } | null {
  const normalized = normalizePath(path);

  for (const [mountPath, mount] of mounts) {
    if (normalized === mountPath || normalized.startsWith(mountPath + '/')) {
      const relativePath = normalized === mountPath
        ? '/'
        : normalized.slice(mountPath.length);
      return { mount, relativePath };
    }
  }

  return null;
}

function normalizePath(path: string): string {
  // Remove trailing slashes, resolve . and ..
  return path.replace(/\/+$/, '').replace(/\/\.\//g, '/').replace(/\/+/g, '/') || '/';
}
```

### Monkey-Patching node:fs/promises

```typescript
// src/patch.ts

import * as nodeFs from 'node:fs/promises';
import { findMount } from './registry';

// Store original implementations
const originals = {
  readFile: nodeFs.readFile,
  writeFile: nodeFs.writeFile,
  stat: nodeFs.stat,
  lstat: nodeFs.lstat,
  readdir: nodeFs.readdir,
  mkdir: nodeFs.mkdir,
  rm: nodeFs.rm,
  rmdir: nodeFs.rmdir,
  unlink: nodeFs.unlink,
  rename: nodeFs.rename,
  copyFile: nodeFs.copyFile,
  access: nodeFs.access,
  // ... etc
};

// Helper to extract path from various argument types
function getPath(pathLike: any): string | null {
  if (typeof pathLike === 'string') return pathLike;
  if (pathLike instanceof URL) return pathLike.pathname;
  if (Buffer.isBuffer(pathLike)) return pathLike.toString();
  return null;
}

// Helper to create Node.js-style errors
function createError(code: string, path: string, syscall: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: ${syscall} '${path}'`) as NodeJS.ErrnoException;
  err.code = code;
  err.path = path;
  err.syscall = syscall;
  return err;
}

// Patch readFile
(nodeFs as any).readFile = async function readFile(
  path: any,
  options?: any
): Promise<Buffer | string> {
  const pathStr = getPath(path);
  if (pathStr) {
    const mountInfo = findMount(pathStr);
    if (mountInfo) {
      const data = await mountInfo.mount.stub.readFile(mountInfo.relativePath);
      const buffer = Buffer.from(data);
      const encoding = typeof options === 'string' ? options : options?.encoding;
      return encoding ? buffer.toString(encoding) : buffer;
    }
  }
  return originals.readFile.call(nodeFs, path, options);
};

// Patch writeFile
(nodeFs as any).writeFile = async function writeFile(
  path: any,
  data: any,
  options?: any
): Promise<void> {
  const pathStr = getPath(path);
  if (pathStr) {
    const mountInfo = findMount(pathStr);
    if (mountInfo) {
      const bytes = typeof data === 'string'
        ? new TextEncoder().encode(data)
        : new Uint8Array(data);
      const flag = typeof options === 'string' ? undefined : options?.flag;
      await mountInfo.mount.stub.writeFile(mountInfo.relativePath, bytes, {
        append: flag === 'a',
        exclusive: flag === 'wx'
      });
      return;
    }
  }
  return originals.writeFile.call(nodeFs, path, data, options);
};

// Patch stat
(nodeFs as any).stat = async function stat(path: any, options?: any): Promise<any> {
  const pathStr = getPath(path);
  if (pathStr) {
    const mountInfo = findMount(pathStr);
    if (mountInfo) {
      const s = await mountInfo.mount.stub.stat(mountInfo.relativePath);
      if (!s) throw createError('ENOENT', pathStr, 'stat');
      return toStats(s);
    }
  }
  return originals.stat.call(nodeFs, path, options);
};

// Patch readdir
(nodeFs as any).readdir = async function readdir(path: any, options?: any): Promise<any> {
  const pathStr = getPath(path);
  if (pathStr) {
    const mountInfo = findMount(pathStr);
    if (mountInfo) {
      const entries = await mountInfo.mount.stub.readdir(mountInfo.relativePath, {
        recursive: options?.recursive
      });
      if (options?.withFileTypes) {
        return entries.map((e: DirEntry) => toDirent(e, pathStr));
      }
      return entries.map((e: DirEntry) => e.name);
    }
  }
  return originals.readdir.call(nodeFs, path, options);
};

// Patch mkdir
(nodeFs as any).mkdir = async function mkdir(path: any, options?: any): Promise<any> {
  const pathStr = getPath(path);
  if (pathStr) {
    const mountInfo = findMount(pathStr);
    if (mountInfo) {
      return mountInfo.mount.stub.mkdir(mountInfo.relativePath, options);
    }
  }
  return originals.mkdir.call(nodeFs, path, options);
};

// Patch rm
(nodeFs as any).rm = async function rm(path: any, options?: any): Promise<void> {
  const pathStr = getPath(path);
  if (pathStr) {
    const mountInfo = findMount(pathStr);
    if (mountInfo) {
      return mountInfo.mount.stub.rm(mountInfo.relativePath, options);
    }
  }
  return originals.rm.call(nodeFs, path, options);
};

// Patch unlink
(nodeFs as any).unlink = async function unlink(path: any): Promise<void> {
  const pathStr = getPath(path);
  if (pathStr) {
    const mountInfo = findMount(pathStr);
    if (mountInfo) {
      return mountInfo.mount.stub.unlink(mountInfo.relativePath);
    }
  }
  return originals.unlink.call(nodeFs, path);
};

// Patch rename (requires both paths to be on same mount)
(nodeFs as any).rename = async function rename(oldPath: any, newPath: any): Promise<void> {
  const oldPathStr = getPath(oldPath);
  const newPathStr = getPath(newPath);

  if (oldPathStr && newPathStr) {
    const oldMount = findMount(oldPathStr);
    const newMount = findMount(newPathStr);

    if (oldMount?.mount !== newMount?.mount) {
      throw createError('EXDEV', oldPathStr, 'rename');
    }

    if (oldMount) {
      if (!oldMount.mount.stub.rename) {
        throw createError('ENOSYS', oldPathStr, 'rename');
      }
      return oldMount.mount.stub.rename(oldMount.relativePath, newMount!.relativePath);
    }
  }

  return originals.rename.call(nodeFs, oldPath, newPath);
};

// ... similar patches for other methods (access, copyFile, rmdir, lstat, etc.)

// Convert WorkerFilesystem Stat to Node.js Stats-like object
function toStats(s: Stat): any {
  const isFile = s.type === 'file';
  const isDir = s.type === 'directory';
  const isSymlink = s.type === 'symlink';

  return {
    isFile: () => isFile,
    isDirectory: () => isDir,
    isSymbolicLink: () => isSymlink,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    size: s.size,
    mtime: s.lastModified || new Date(0),
    mtimeMs: (s.lastModified || new Date(0)).getTime(),
    birthtime: s.created || new Date(0),
    birthtimeMs: (s.created || new Date(0)).getTime(),
    atime: s.lastModified || new Date(0),
    atimeMs: (s.lastModified || new Date(0)).getTime(),
    ctime: s.lastModified || new Date(0),
    ctimeMs: (s.lastModified || new Date(0)).getTime(),
    mode: isDir ? 0o755 : 0o644,
    uid: 0,
    gid: 0,
    nlink: 1,
    dev: 0,
    ino: 0,
    rdev: 0,
    blksize: 4096,
    blocks: Math.ceil(s.size / 512),
  };
}

// Convert DirEntry to Node.js Dirent-like object
function toDirent(e: DirEntry, parentPath: string): any {
  const isFile = e.type === 'file';
  const isDir = e.type === 'directory';
  const isSymlink = e.type === 'symlink';

  return {
    name: e.name,
    parentPath,
    isFile: () => isFile,
    isDirectory: () => isDir,
    isSymbolicLink: () => isSymlink,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}
```

### Package Exports

```typescript
// src/index.ts

// Side effect: patch node:fs/promises on import
import './patch';

export { mount } from './registry';
export type { WorkerFilesystem, Stat, DirEntry, MountHandle } from './types';
```

## Constraints

1. **Async only** - All operations are async (returning Promises). Sync operations are not supported on mounted paths since jsrpc is async.

2. **No file descriptors** - The fd-based API (`open`/`read`/`write`/`close`) is not supported. Use the high-level methods instead.

3. **Same-mount operations** - `rename` and `cp` only work within the same mount. Cross-mount operations throw `EXDEV`.

4. **Mount lifetime** - Mounts persist until `unmount()` is called or the isolate terminates. For request-scoped mounts, call `unmount()` in a `finally` block.

## Error Handling

Errors should follow Node.js conventions:

| Code | Meaning |
|------|---------|
| `ENOENT` | File or directory not found |
| `EEXIST` | File already exists |
| `ENOTDIR` | Expected directory but found file |
| `EISDIR` | Expected file but found directory |
| `ENOSYS` | Operation not supported by this filesystem |
| `EXDEV` | Cross-mount operation not supported |
| `EACCES` | Permission denied |

## Concurrency

The remote filesystem implementation handles concurrency. For consistent state, use Durable Objects:

```typescript
export class StorageDO extends DurableObject implements WorkerFilesystem {
  // All methods are automatically serialized by the DO runtime
  async readFile(path: string) { /* ... */ }
  async writeFile(path: string, data: Uint8Array) { /* ... */ }
}
```

## Large File Support

Three approaches for different use cases:

1. **Whole-file** (`readFile`/`writeFile`) - Simple, for small files
2. **Chunked** (`read`/`write` with offset) - Random access, for medium files
3. **Streaming** (`createReadStream`/`createWriteStream`) - Sequential access, for large files

```typescript
// Streaming example
const stream = await mount.stub.createReadStream('/large-file.bin');
for await (const chunk of stream) {
  // Process chunk
}
```

## Future Considerations

1. **Patch `node:fs` sync functions** - Patch sync functions (`readFileSync`, `writeFileSync`, etc.) to throw a clear error when accessing mounted paths, rather than silently accessing the wrong location or failing confusingly:
   ```typescript
   import fs from 'node:fs';

   fs.readFileSync('/mnt/remote/file.txt');
   // Error: Synchronous operations not supported on mounted path '/mnt/remote'.
   // Use node:fs/promises instead.
   ```

2. **Watch API** - `fs.watch()` via event streams over jsrpc

3. **Caching layer** - Optional caching for remote filesystems

4. **Partial interface detection** - Runtime detection of supported methods
