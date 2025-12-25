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
- Streaming read/write support
- Atomic operations within a single request

## API

The `DurableObjectFilesystem` class implements the full `WorkerFilesystem` interface:

### Core Operations

| Method | Description |
|--------|-------------|
| `stat(path, options?)` | Get file/directory metadata |
| `readFile(path)` | Read entire file contents |
| `writeFile(path, data, options?)` | Write file contents |
| `readdir(path, options?)` | List directory contents |
| `mkdir(path, options?)` | Create a directory |
| `rm(path, options?)` | Remove file or directory |
| `unlink(path)` | Remove file or symlink |

### Additional Operations

| Method | Description |
|--------|-------------|
| `read(path, options)` | Read chunk at offset |
| `write(path, data, options)` | Write at offset |
| `createReadStream(path, options?)` | Create readable stream |
| `createWriteStream(path, options?)` | Create writable stream |
| `truncate(path, length?)` | Truncate file |
| `setLastModified(path, mtime)` | Set modification time |
| `symlink(linkPath, targetPath)` | Create symbolic link |
| `readlink(path)` | Read symlink target |
| `rename(oldPath, newPath)` | Rename/move file |
| `cp(src, dest, options?)` | Copy file or directory |
| `access(path, mode?)` | Check if path exists |

## Storage

Data is stored in the Durable Object's SQLite database with the following schema:

```sql
CREATE TABLE entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  parent_path TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('file', 'directory', 'symlink')),
  size INTEGER NOT NULL DEFAULT 0,
  content BLOB,
  symlink_target TEXT,
  created_at INTEGER NOT NULL,
  modified_at INTEGER NOT NULL
);
```

## Limitations

- **File size**: SQLite BLOBs can store files up to several GB, but large files (>100MB) may impact performance
- **Streaming**: Streams buffer content in memory before writing to SQLite
- **Concurrency**: Durable Objects are single-threaded, so concurrent access from multiple workers serializes automatically

## License

MIT
