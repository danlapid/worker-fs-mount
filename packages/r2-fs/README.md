# r2-fs

An R2-backed filesystem implementation for Cloudflare Workers. Can be mounted via `worker-fs-mount` to provide persistent filesystem storage using Cloudflare R2 object storage.

## Installation

```bash
npm install r2-fs worker-fs-mount
```

## Usage

### 1. Configure wrangler.toml

```toml
[[r2_buckets]]
binding = "MY_BUCKET"
bucket_name = "my-bucket-name"

[alias]
"node:fs/promises" = "worker-fs-mount/fs"
```

### 2. Generate types with wrangler

```bash
wrangler types
```

This generates a `worker-configuration.d.ts` file with typed bindings for your R2 bucket.

### 3. Use in your Worker

```typescript
import { env } from 'cloudflare:workers';
import { R2Filesystem } from 'r2-fs';
import { mount } from 'worker-fs-mount';
import fs from 'node:fs/promises';

// Create filesystem backed by R2 at module level
const r2fs = new R2Filesystem(env.MY_BUCKET);
mount('/storage', r2fs);

export default {
  async fetch(request: Request): Promise<Response> {
    // Use standard fs operations
    await fs.writeFile('/storage/hello.txt', 'Hello, World!');
    const content = await fs.readFile('/storage/hello.txt', 'utf8');

    // Create directories
    await fs.mkdir('/storage/projects/my-app', { recursive: true });

    // List directory contents
    const files = await fs.readdir('/storage/projects');

    return new Response(content);
  }
}
```

## Features

- Full `WorkerFilesystem` interface implementation
- Persistent storage via R2 (survives restarts)
- Support for files, directories, and symlinks
- Streaming read/write support
- Large file support (up to 5GB per file)
- Automatic symlink resolution

## API

The `R2Filesystem` class implements the full `WorkerFilesystem` interface. See the [worker-fs-mount README](../worker-fs-mount/README.md) for the complete API reference.

## Storage

Data is stored in R2 using the following conventions:

- **Files**: Stored as R2 objects at their path (e.g., `/foo/bar.txt` -> `foo/bar.txt`)
- **Directories**: Created as marker objects with a `.dir` suffix (e.g., `/foo/mydir` -> `foo/mydir.dir`)
- **Symlinks**: Stored as empty objects with `symlinkTarget` in custom metadata
- **Metadata**: File type, creation time, and symlink targets stored in R2 custom metadata

## Limitations

- **File size**: R2 supports files up to 5GB, but very large files may impact performance
- **Partial writes**: R2 doesn't support partial writes, so writing at an offset requires read-modify-write
- **Streaming writes**: Streams buffer content in memory before writing to R2

## R2 vs Durable Object Storage

| Feature | r2-fs | durable-object-fs |
|---------|-------|-------------------|
| Max file size | 5GB | ~100MB recommended |
| Storage cost | Lower (R2 pricing) | Higher (DO pricing) |
| Latency | Higher (object storage) | Lower (edge SQLite) |
| Concurrency | Automatic | Single-threaded DO |
| Use case | Large files, archives | Small files, metadata |

## License

MIT
