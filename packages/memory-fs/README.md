# memory-fs

An in-memory filesystem implementation for Cloudflare Workers. Can be mounted via `worker-fs-mount` to provide ephemeral filesystem storage that persists within a single Worker instance.

## Installation

```bash
npm install memory-fs worker-fs-mount
```

## Usage

### 1. Configure wrangler.toml

```toml
[alias]
"node:fs/promises" = "worker-fs-mount/fs"
```

### 2. Use in your Worker

```typescript
import { MemoryFilesystem } from 'memory-fs';
import { mount, withMounts } from 'worker-fs-mount';
import fs from 'node:fs/promises';

// Re-export to make available via ctx.exports
export { MemoryFilesystem };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return withMounts(async () => {
      // Mount the in-memory filesystem
      mount('/mem', ctx.exports.MemoryFilesystem);

      // Use standard fs operations
      await fs.writeFile('/mem/hello.txt', 'Hello, World!');
      const content = await fs.readFile('/mem/hello.txt', 'utf8');

      // Create directories
      await fs.mkdir('/mem/projects/my-app', { recursive: true });

      // List directory contents
      const files = await fs.readdir('/mem/projects');

      return new Response(content);
    });
  }
}
```

## Features

- Full `WorkerFilesystem` interface implementation
- Zero external dependencies (pure in-memory Map storage)
- Support for files, directories, and symlinks
- Streaming read/write support
- Shared state across requests (within same isolate)
- Reset functionality for testing

## API

The `MemoryFilesystem` class extends `WorkerEntrypoint` and implements the full `WorkerFilesystem` interface:

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

### Static Methods

| Method | Description |
|--------|-------------|
| `MemoryFilesystem.resetState()` | Reset the shared filesystem state to empty (useful for testing) |

## Storage

Data is stored in a shared JavaScript `Map<string, FsNode>` where:

- Keys are normalized absolute paths (e.g., `/foo/bar.txt`)
- Values are node objects containing type, content (for files), and metadata
- State is shared across all instances within the same isolate

## Use Cases

- **Testing**: Fast, isolated filesystem for unit tests
- **Caching**: Temporary file cache within a request or session
- **Scratch space**: Working directory for file processing pipelines
- **Development**: Local development without external storage dependencies

## Comparison with Other Filesystems

| Feature | memory-fs | durable-object-fs | r2-fs |
|---------|-----------|-------------------|-------|
| Persistence | Within isolate | Permanent | Permanent |
| Max file size | Memory limited | ~100MB | 5GB |
| Latency | Instant | Low | Higher |
| Cost | Free (memory) | DO pricing | R2 pricing |
| Use case | Testing, temp files | Small persistent files | Large files |

## Limitations

- **Ephemeral**: Data is lost when the Worker isolate is recycled
- **Memory bound**: Total storage limited by Worker memory limits
- **Single isolate**: State is not shared across different Worker instances
- **No durability**: Not suitable for data that must survive restarts

## License

MIT
