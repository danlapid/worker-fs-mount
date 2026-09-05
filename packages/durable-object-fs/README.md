# durable-object-fs

A Durable Object that implements a filesystem interface using SQLite storage. Can be mounted via `worker-fs-mount` to provide persistent filesystem storage in Cloudflare Workers.

## Installation

```bash
npm install durable-object-fs worker-fs-mount
```

## Usage

### 1. Configure wrangler.toml

```toml
[[migrations]]
tag = "v1"
new_sqlite_classes = ["DurableObjectFilesystem"]

[alias]
"node:fs/promises" = "worker-fs-mount/fs"
```

Note: No `[[durable_objects.bindings]]` section is needed - use `ctx.exports` to access the Durable Object namespace directly.

### 2. Generate types with wrangler

```bash
wrangler types
```

This generates a `worker-configuration.d.ts` file with typed exports for your Durable Objects.

### 3. Export the Durable Object and use it

```typescript
import { DurableObjectFilesystem } from 'durable-object-fs';
import { mount, withMounts } from 'worker-fs-mount';
import { WorkerEntrypoint } from 'cloudflare:workers';
import fs from 'node:fs/promises';

// Export the Durable Object class
export { DurableObjectFilesystem };

export default class extends WorkerEntrypoint<Env> {
  async fetch(request: Request) {
    // Durable Objects require request scope - use withMounts
    return withMounts(async () => {
      // Get a Durable Object instance via ctx.exports (fully typed!)
      const id = this.ctx.exports.DurableObjectFilesystem.idFromName('shared');
      const stub = this.ctx.exports.DurableObjectFilesystem.get(id);

      // Mount the filesystem
      mount('/data', stub);

      // Use standard fs operations
      await fs.writeFile('/data/hello.txt', 'Hello, World!');
      const content = await fs.readFile('/data/hello.txt', 'utf8');

      // Create directories
      await fs.mkdir('/data/projects/my-app', { recursive: true });

      // List directory contents
      const files = await fs.readdir('/data/projects');

      return new Response(content);
    });
  }
}
```

## Features

- Full `WorkerFilesystem` interface implementation
- Persistent storage via SQLite (survives restarts)
- Support for files, directories, and symlinks
- Paged streaming and random-access I/O, including sparse files
- Synchronous file descriptors inside the owning Durable Object
- Transactional file writes, truncation, and local renames

## API

The `DurableObjectFilesystem` class implements the full `WorkerFilesystem` interface. See the [worker-fs-mount README](../worker-fs-mount/README.md) for the complete API reference.

## Synchronous access inside a Durable Object

Alias `node:fs` to `worker-fs-mount/fs-sync` in Wrangler, then mount a
`LocalDOFilesystem` with the **full storage object**:

```typescript
import { DurableObject } from 'cloudflare:workers';
import fs from 'node:fs';
import { LocalDOFilesystem } from 'durable-object-fs';
import { mount, withMounts } from 'worker-fs-mount';

export class MyDO extends DurableObject {
  private readonly filesystem = new LocalDOFilesystem(this.ctx.storage);

  fetch(): Response {
    return withMounts(() => {
      mount('/data', this.filesystem);
      const fd = fs.openSync('/data/world.bin', 'a+');
      try {
        fs.writeSync(fd, new Uint8Array([1, 2, 3]));
        return Response.json({ size: fs.fstatSync(fd).size });
      } finally {
        fs.closeSync(fd);
      }
    });
  }
}
```

Use a SQLite migration for your `MyDO` class. `withMounts()` isolates mounts and
descriptors from other Durable Objects sharing the same Worker isolate.

`LocalDOFilesystem(ctx.storage)` uses `transactionSync()` for atomic paged writes,
truncation, and inode-preserving rename. An existing `LocalDOFilesystem(ctx.storage.sql)`
continues to support small inline writes and reading both storage formats, including
read-only descriptors. Writable descriptors and large writes need the full storage
object; the SQL-only constructor reports `ENOSYS` for these operations. Its rename
continues to use the mount library's copy/delete fallback.

## Storage and large files

File metadata stays in `entries`. Contents are stored in `file_pages`, keyed by
`(entry_id, page_index)`, with each BLOB at most 64 KiB. This avoids the Durable
Object SQLite [2 MB row limit](https://developers.cloudflare.com/durable-objects/platform/limits/).
Partial writes update only the pages they touch. Sparse extension stores a logical
size; missing pages read as zeroes. Truncating and extending again cannot expose
previously truncated bytes.

Existing databases are upgraded automatically. Old inline `entries.content` BLOBs
remain readable and migrate to pages on mutation through the paged API. No export or
manual migration is required. Older releases cannot read paged contents, so do not
downgrade after writing with this version.

`DurableObjectFilesystem` read streams produce chunks of at most 64 KiB. Write streams
persist each supplied chunk transactionally, without accumulating the entire file.
Opening a write stream with `w` creates or truncates immediately; aborting it retains
already-written chunks. A stream or multi-call application operation is not one
transaction. `LocalDOFilesystem.writeFileSync()` is atomic for the entire call when
constructed with full storage.

## Limits and semantics

- `readFile` and `writeFile` still hold the caller's complete buffer in memory. Use
  streams or descriptors for bounded-memory I/O. Available database storage, Worker
  memory, and execution limits still apply.
- Open handles refer to inodes: local rename, unlink, or replacement does not redirect
  them to a new file. After unlink/replacement, populated pages are retained in memory
  until the last handle closes; sparse holes remain unallocated. Close handles promptly
  when deleting large files. Unlinked data and descriptors do not survive eviction.
- Mutate files through the filesystem API. Direct changes to its SQL tables bypass
  open-handle bookkeeping.
- Permission bits are metadata; this package does not enforce Unix users or permissions.
- `fsyncSync`/`fdatasyncSync` validate the handle. SQL writes use Durable Object storage
  output gates; use `await ctx.storage.sync()` when you need an explicit asynchronous
  durability barrier.

## License

MIT
