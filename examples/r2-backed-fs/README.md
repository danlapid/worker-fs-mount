# R2-backed Filesystem Example

This example demonstrates using `worker-fs-mount` and `r2-fs` together to create a persistent filesystem backed by Cloudflare R2 object storage.

## Features

- Uses standard `node:fs/promises` APIs
- Files persist across requests and Worker restarts
- Interactive web UI for exploring the filesystem
- Create, edit, and delete files and folders
- Supports files up to 5GB per file

## Running locally

```bash
# From this directory
pnpm install
pnpm dev
```

Then open http://localhost:8787 in your browser.

## How it works

1. **Wrangler alias** replaces `node:fs/promises` with `worker-fs-mount/fs`:
   ```toml
   [alias]
   "node:fs/promises" = "worker-fs-mount/fs"
   ```

2. **R2 bucket** provides persistent object storage:
   ```toml
   [[r2_buckets]]
   binding = "STORAGE"
   bucket_name = "my-storage-bucket"
   ```

3. **Mount** the R2 filesystem at module level:
   ```typescript
   import { env } from 'cloudflare:workers';
   import { R2Filesystem } from 'r2-fs';
   import { mount } from 'worker-fs-mount';
   import fs from 'node:fs/promises';

   // Mount at module level using importable env
   const r2fs = new R2Filesystem(env.STORAGE);
   mount('/storage', r2fs);

   export default {
     async fetch(request: Request): Promise<Response> {
       // Now use standard fs operations!
       await fs.writeFile('/storage/hello.txt', 'Hello, World!');
       const content = await fs.readFile('/storage/hello.txt', 'utf8');

       return new Response(content);
     }
   }
   ```

## Deploying

```bash
pnpm deploy
```

Note: You'll need to be logged in to Cloudflare (`wrangler login`) and have an R2 bucket created.
