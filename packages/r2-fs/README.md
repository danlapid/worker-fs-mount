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

### Alternative: Wrap in a WorkerEntrypoint

For service bindings or more complex setups, you can wrap `R2Filesystem` in a WorkerEntrypoint:

```typescript
import { R2Filesystem } from 'r2-fs';
import type { WorkerFilesystem } from 'worker-fs-mount';
import { WorkerEntrypoint } from 'cloudflare:workers';

export class MyFilesystem extends WorkerEntrypoint<Env> implements WorkerFilesystem {
  private fs = new R2Filesystem(this.env.MY_BUCKET);

  stat = this.fs.stat.bind(this.fs);
  readFile = this.fs.readFile.bind(this.fs);
  writeFile = this.fs.writeFile.bind(this.fs);
  readdir = this.fs.readdir.bind(this.fs);
  mkdir = this.fs.mkdir.bind(this.fs);
  rm = this.fs.rm.bind(this.fs);
  unlink = this.fs.unlink.bind(this.fs);
  rename = this.fs.rename.bind(this.fs);
  cp = this.fs.cp.bind(this.fs);
  symlink = this.fs.symlink.bind(this.fs);
  readlink = this.fs.readlink.bind(this.fs);
  truncate = this.fs.truncate.bind(this.fs);
  access = this.fs.access.bind(this.fs);
  setLastModified = this.fs.setLastModified.bind(this.fs);
  read = this.fs.read.bind(this.fs);
  write = this.fs.write.bind(this.fs);
  createReadStream = this.fs.createReadStream.bind(this.fs);
  createWriteStream = this.fs.createWriteStream.bind(this.fs);
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
- **Partial writes**: R2 doesn't support partial writes, so `write()` at offset requires read-modify-write
- **Modification time**: `setLastModified()` is a no-op as R2 doesn't support updating metadata without re-uploading
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
