# Synchronous Filesystem in Durable Objects Example

This example demonstrates using `worker-fs-mount` with `LocalDOFilesystem` to enable **synchronous** `node:fs` operations inside a Durable Object.

## Why Sync Filesystem?

Some libraries and use cases require synchronous filesystem access. Inside a Durable Object, `LocalDOFilesystem` provides true synchronous operations by using `ctx.storage.sql` directly, which is synchronous within the DO context.

## Features

- Uses synchronous `node:fs` APIs (`readFileSync`, `writeFileSync`, etc.)
- Files persist in DO's SQLite storage
- Strong consistency guaranteed by DO's single-threaded execution
- Interactive web UI for exploring the filesystem

## Running locally

```bash
# From this directory
pnpm install
pnpm dev
```

Then open http://localhost:8787 in your browser.

## How it works

1. **Wrangler aliases** replace both async and sync fs modules:
   ```toml
   [alias]
   "node:fs/promises" = "worker-fs-mount/fs"
   "node:fs" = "worker-fs-mount/fs-sync"
   ```

2. **Durable Object** with SQLite storage:
   ```toml
   [[migrations]]
   tag = "v1"
   new_sqlite_classes = ["SyncFilesystemDO"]
   ```

3. **LocalDOFilesystem** enables sync operations inside the DO:
   ```typescript
   import { DurableObject } from 'cloudflare:workers';
   import fs from 'node:fs'; // Aliased to sync implementation
   import { LocalDOFilesystem } from 'durable-object-fs';
   import { mount } from 'worker-fs-mount';

   export class SyncFilesystemDO extends DurableObject {
     constructor(ctx: DurableObjectState, env: Env) {
       super(ctx, env);
       // Create and mount once in constructor - DOs are single-threaded
       const localFs = new LocalDOFilesystem(ctx.storage.sql);
       mount('/data', localFs);
     }

     fetch(request: Request): Response {
       // Synchronous fs operations work!
       if (fs.existsSync('/data/config.json')) {
         const config = fs.readFileSync('/data/config.json', 'utf8');
         return new Response(config);
       }

       fs.writeFileSync('/data/config.json', JSON.stringify({ initialized: true }));
       return new Response('Config created');
     }
   }
   ```

## Key Differences from Async Example

| Aspect | Async (`DurableObjectFilesystem`) | Sync (`LocalDOFilesystem`) |
|--------|-----------------------------------|----------------------------|
| Location | Can be called from any Worker | Must run inside a DO |
| API | `fs.promises.*` / `await fs.*` | `fs.*Sync()` |
| Use case | General purpose | Libraries requiring sync fs |
| Access | Via jsrpc (stub) | Direct SQLite access |

## When to Use This

- Libraries that require synchronous filesystem access
- Simple scripts that don't need async/await complexity
- Cases where strong consistency is required (DO guarantees single-threaded execution)

## Deploying

```bash
pnpm deploy
```

Note: You'll need to be logged in to Cloudflare (`wrangler login`).
