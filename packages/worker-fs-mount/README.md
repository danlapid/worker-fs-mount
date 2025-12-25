# worker-fs-mount

Mount WorkerEntrypoints as virtual filesystems in Cloudflare Workers. This package provides a drop-in replacement for `node:fs/promises` that intercepts filesystem calls and redirects them to your WorkerEntrypoint implementations via jsrpc.

## Features

- **Simple setup** - Just add an alias to `wrangler.toml` and your existing `node:fs/promises` code works
- **Multiple mount sources** - Works with `ctx.exports`, service bindings, and Durable Objects
- **Full fs coverage** - Supports 20+ filesystem operations (read, write, stat, readdir, mkdir, rm, rename, etc.)
- **TypeScript-first** - Full type definitions with strict types
- **Cross-mount safety** - Properly handles operations across mount boundaries

## Installation

```bash
npm install worker-fs-mount
```

## Setup

Add the following alias to your `wrangler.toml`:

```toml
[alias]
"node:fs/promises" = "worker-fs-mount/fs"
```

This replaces `node:fs/promises` imports with our mount-aware implementation at build time.

## Quick Start

```typescript
import { mount } from 'worker-fs-mount';
import fs from 'node:fs/promises';

export default {
  async fetch(request, env) {
    // Mount a service binding as a filesystem
    const handle = mount('/mnt/storage', env.STORAGE_SERVICE);

    try {
      // Standard fs operations are automatically intercepted
      await fs.writeFile('/mnt/storage/data.json', JSON.stringify({ hello: 'world' }));
      const content = await fs.readFile('/mnt/storage/data.json', 'utf8');

      // Non-mounted paths work normally
      await fs.readFile('/tmp/local.txt');

      return new Response(content);
    } finally {
      handle.unmount();
    }
  }
};
```

## How It Works

With the wrangler alias configured, every `node:fs/promises` import is replaced with our implementation. Each filesystem call checks if the path falls under a mounted location:

```
fs.readFile('/mnt/storage/file.txt')
       ↓
Is '/mnt/storage' mounted? → YES → Call stub.readFile('/file.txt') via jsrpc
       ↓
Is '/tmp/file.txt' mounted? → NO → Use native node:fs/promises
```

Both import styles work:
```typescript
import fs from 'node:fs/promises';
import { readFile, writeFile } from 'node:fs/promises';

// Both are intercepted for mounted paths
await fs.readFile('/mnt/storage/file.txt');
await readFile('/mnt/storage/file.txt');
```

## Mount Sources

### Service Bindings

```typescript
// wrangler.toml
// [[services]]
// binding = "STORAGE"
// service = "storage-worker"

mount('/mnt/storage', env.STORAGE);
```

### Same-Worker Entrypoints

```typescript
export class MyFilesystem extends WorkerEntrypoint {
  async readFile(path) { /* ... */ }
  // ...
}

export default class extends WorkerEntrypoint {
  async fetch() {
    mount('/mnt/local', this.ctx.exports.MyFilesystem);
  }
}
```

### Durable Objects

Access via `ctx.exports` (recommended) - run `wrangler types` to generate types:

```typescript
export class StorageDO extends DurableObject implements WorkerFilesystem {
  // ... implement filesystem methods
}

export default class extends WorkerEntrypoint<Env> {
  async fetch() {
    // ctx.exports provides typed access to your exported Durable Objects
    const id = this.ctx.exports.StorageDO.idFromName('user-123');
    const stub = this.ctx.exports.StorageDO.get(id);
    mount('/mnt/user', stub);
  }
}
```

## Implementing a WorkerFilesystem

Your entrypoint must implement the `WorkerFilesystem` interface. Here's a minimal in-memory example:

```typescript
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { WorkerFilesystem, Stat, DirEntry } from 'worker-fs-mount';

export class MemoryFS extends WorkerEntrypoint implements WorkerFilesystem {
  #files = new Map<string, Uint8Array>();
  #dirs = new Set<string>(['/']);

  async stat(path: string): Promise<Stat | null> {
    if (this.#dirs.has(path)) {
      return { type: 'directory', size: 0 };
    }
    const file = this.#files.get(path);
    if (!file) return null;
    return { type: 'file', size: file.length };
  }

  async readFile(path: string): Promise<Uint8Array> {
    const file = this.#files.get(path);
    if (!file) throw new Error(`ENOENT: no such file: ${path}`);
    return file;
  }

  async writeFile(path: string, data: Uint8Array): Promise<number> {
    this.#files.set(path, new Uint8Array(data));
    return data.length;
  }

  async readdir(path: string): Promise<DirEntry[]> {
    const prefix = path === '/' ? '/' : path + '/';
    const entries: DirEntry[] = [];
    const seen = new Set<string>();

    for (const [filePath] of this.#files) {
      if (filePath.startsWith(prefix)) {
        const name = filePath.slice(prefix.length).split('/')[0];
        if (name && !seen.has(name)) {
          seen.add(name);
          entries.push({ name, type: 'file' });
        }
      }
    }
    return entries;
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined> {
    if (this.#dirs.has(path)) return undefined;
    this.#dirs.add(path);
    return path;
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    if (!this.#files.delete(path) && !this.#dirs.delete(path)) {
      if (!options?.force) throw new Error(`ENOENT: ${path}`);
    }
  }

  async unlink(path: string): Promise<void> {
    if (!this.#files.delete(path)) {
      throw new Error(`ENOENT: ${path}`);
    }
  }
}
```

For a production implementation backed by R2, KV, or a database, see the examples in `SPEC.md`.

## API Reference

### `mount(path, stub): void`

Mount a WorkerFilesystem at the specified path.

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | `string` | Mount point (must be absolute, start with `/`) |
| `stub` | `WorkerFilesystem` | WorkerEntrypoint stub |

### `unmount(path): boolean`

Unmount a filesystem at the specified path.

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | `string` | Mount point to unmount |

Returns `true` if a mount was removed, `false` if nothing was mounted at that path.

### `findMount(path): MountMatch | null`

Find the mount for a given path.

Returns `{ mount, relativePath }` if found, `null` otherwise.

### `isMounted(path): boolean`

Check if a path is under any mount.

### `getMounts(): string[]`

Get all active mount paths.

### `clearMounts(): void`

Remove all mounts (useful for testing).

## WorkerFilesystem Interface

### Required Methods

| Method | Description |
|--------|-------------|
| `stat(path, options?)` | Get file/directory metadata |
| `readFile(path)` | Read entire file as `Uint8Array` |
| `writeFile(path, data, options?)` | Write entire file |
| `readdir(path, options?)` | List directory contents |
| `mkdir(path, options?)` | Create directory |
| `rm(path, options?)` | Remove file or directory |
| `unlink(path)` | Remove file |

### Optional Methods

| Method | Description |
|--------|-------------|
| `read(path, {offset, length})` | Read chunk at offset |
| `write(path, data, {offset})` | Write at offset |
| `createReadStream(path, options?)` | Get readable stream |
| `createWriteStream(path, options?)` | Get writable stream |
| `truncate(path, length?)` | Truncate file |
| `rename(oldPath, newPath)` | Move file/directory |
| `cp(src, dest, options?)` | Copy file/directory |
| `symlink(linkPath, targetPath)` | Create symlink |
| `readlink(path)` | Read symlink target |
| `access(path, mode?)` | Check accessibility |
| `setLastModified(path, mtime)` | Update modification time |

## Supported fs Operations

The following `node:fs/promises` methods are intercepted:

- `readFile`, `writeFile`, `appendFile`
- `stat`, `lstat`
- `readdir`
- `mkdir`, `rmdir`, `rm`
- `unlink`
- `rename`
- `copyFile`, `cp`
- `access`
- `truncate`
- `symlink`, `readlink`
- `realpath`
- `utimes`

## Constraints

### Async Only

Only `node:fs/promises` is supported. Synchronous operations (`readFileSync`, etc.) are not intercepted and will use the native filesystem.

### No File Descriptors

The fd-based API (`open`/`read`/`write`/`close`) is not supported. Use the high-level methods instead.

### Same-Mount Operations

`rename` only works within the same mount. Cross-mount rename throws `EXDEV`. For cross-mount moves, use `copyFile` + `unlink`.

### Reserved Paths

Cannot mount over `/bundle`, `/tmp`, or `/dev`.

### No Nested Mounts

Cannot mount `/mnt/a/b` if `/mnt/a` is already mounted, or vice versa.

## Error Handling

Errors follow Node.js conventions with `.code` property:

| Code | Meaning |
|------|---------|
| `ENOENT` | File or directory not found |
| `EEXIST` | File already exists |
| `ENOTDIR` | Expected directory but found file |
| `EISDIR` | Expected file but found directory |
| `ENOSYS` | Operation not supported by filesystem |
| `EXDEV` | Cross-mount operation not supported |
| `EACCES` | Permission denied |

## Concurrency

The mounted WorkerFilesystem is responsible for handling concurrent access. For consistent state, use Durable Objects which provide single-threaded execution:

```typescript
export class StorageDO extends DurableObject implements WorkerFilesystem {
  // All methods automatically serialized by DO runtime
}
```

## License

MIT
