# Durable Object-backed Filesystem Example

This example demonstrates using `worker-fs-mount` and `durable-object-fs` together to create a persistent filesystem backed by a Durable Object with SQLite storage.

## Features

- Uses standard `node:fs/promises` APIs
- Files persist across requests and Worker restarts
- Interactive web UI for exploring the filesystem
- Create, edit, and delete files and folders

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

2. **Durable Object** provides persistent SQLite storage:
   ```toml
   [[migrations]]
   tag = "v1"
   new_sqlite_classes = ["DurableObjectFilesystem"]
   ```

3. **Mount** the DO filesystem at a path:
   ```typescript
   import { DurableObjectFilesystem } from 'durable-object-fs';
   import { mount, withMounts } from 'worker-fs-mount';
   import { WorkerEntrypoint } from 'cloudflare:workers';
   import fs from 'node:fs/promises';

   export { DurableObjectFilesystem };

   export default class extends WorkerEntrypoint<Env> {
     async fetch(request: Request) {
       // Durable Objects require request scope - use withMounts
       return withMounts(async () => {
         const id = this.ctx.exports.DurableObjectFilesystem.idFromName('demo');
         const stub = this.ctx.exports.DurableObjectFilesystem.get(id);
         mount('/data', stub);

         // Now use standard fs operations!
         await fs.writeFile('/data/hello.txt', 'Hello, World!');
         const content = await fs.readFile('/data/hello.txt', 'utf8');

         return new Response(content);
       });
     }
   }
   ```

## Deploying

```bash
pnpm deploy
```

Note: You'll need to be logged in to Cloudflare (`wrangler login`).
