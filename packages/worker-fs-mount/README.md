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
import { env } from 'cloudflare:workers';
import { mount } from 'worker-fs-mount';
import fs from 'node:fs/promises';

// Mount at module level using importable env
mount('/mnt/storage', env.STORAGE_SERVICE);

export default {
  async fetch(request) {
    // Standard fs operations are automatically intercepted
    await fs.writeFile('/mnt/storage/data.json', JSON.stringify({ hello: 'world' }));
    const content = await fs.readFile('/mnt/storage/data.json', 'utf8');

    // Non-mounted paths work normally
    await fs.readFile('/tmp/local.txt');

    return new Response(content);
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

Your entrypoint must implement the `WorkerFilesystem` interface. The interface is stream-first - you implement 6 core methods and higher-level operations like `readFile`/`writeFile` are automatically derived.

Here's a minimal in-memory example:

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

  async createReadStream(path: string, options?: { start?: number; end?: number }): Promise<ReadableStream<Uint8Array>> {
    const file = this.#files.get(path);
    if (!file) throw new Error(`ENOENT: ${path}`);
    const start = options?.start ?? 0;
    const end = options?.end !== undefined ? options.end + 1 : file.length;
    const chunk = file.slice(start, end);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(chunk);
        controller.close();
      },
    });
  }

  async createWriteStream(path: string, options?: { start?: number; flags?: 'w' | 'a' | 'r+' }): Promise<WritableStream<Uint8Array>> {
    const self = this;
    let offset = options?.start ?? 0;
    let content = options?.flags === 'a' || options?.flags === 'r+'
      ? (this.#files.get(path) ?? new Uint8Array(0))
      : new Uint8Array(0);
    if (options?.flags === 'a') offset = content.length;

    return new WritableStream({
      write(chunk) {
        const newLength = Math.max(content.length, offset + chunk.length);
        const newContent = new Uint8Array(newLength);
        newContent.set(content, 0);
        newContent.set(chunk, offset);
        content = newContent;
        offset += chunk.length;
        self.#files.set(path, content);
      },
    });
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
}
```

For production implementations, see the `r2-fs`, `durable-object-fs`, and `memory-fs` packages.

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

### `withMounts(fn): Promise<T>`

Run a function with request-scoped mount isolation. Required for Durable Objects (getting a DO stub is IO). Use when different requests need different mounts (e.g., per-user DOs).

```typescript
// Durable Objects require request scope - use withMounts for isolation
return withMounts(async () => {
  const userId = getUserId(request);
  const id = ctx.exports.UserStorage.idFromName(userId);
  mount('/user', ctx.exports.UserStorage.get(id));
  // Each request gets its own isolated mount
});
```

For R2, KV, service bindings, and same-worker entrypoints, prefer mounting at module level using `import { env, exports } from 'cloudflare:workers'`.

### `isMounted(path): boolean`

Check if a path is under any mount.

### `isInMountContext(): boolean`

Check if code is running inside a `withMounts` callback.

## WorkerFilesystem Interface

The interface is stream-first with minimal required methods. Higher-level operations like `readFile`, `writeFile`, `truncate`, `rename`, `cp`, and `unlink` are automatically derived from these core methods.

### Required Methods (6)

| Method | Description |
|--------|-------------|
| `stat(path, options?)` | Get file/directory metadata |
| `createReadStream(path, options?)` | Create readable stream for a file |
| `createWriteStream(path, options?)` | Create writable stream for a file |
| `readdir(path, options?)` | List directory contents |
| `mkdir(path, options?)` | Create directory |
| `rm(path, options?)` | Remove file or directory |

### Optional Methods (2)

| Method | Description |
|--------|-------------|
| `symlink(linkPath, targetPath)` | Create symlink |
| `readlink(path)` | Read symlink target |

### Automatically Derived Operations

These `node:fs/promises` methods are automatically implemented using the core streaming methods:

| Method | Derived From |
|--------|--------------|
| `readFile` | `createReadStream` |
| `writeFile` | `createWriteStream` |
| `appendFile` | `createWriteStream` with append flag |
| `truncate` | `createReadStream` + `createWriteStream` |
| `unlink` | `stat` + `rm` |
| `copyFile`, `cp` | `createReadStream` + `createWriteStream` |
| `rename` | streams + `rm` |
| `access` | `stat` |

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
