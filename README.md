# worker-fs-mount

Mount WorkerEntrypoints as virtual filesystems in Cloudflare Workers.

## Try It Out

See it in action with an interactive filesystem explorer backed by a Durable Object:

```bash
git clone https://github.com/danlapid/worker-fs-mount
cd worker-fs-mount
pnpm install
pnpm example
```

Open http://localhost:8787 to create, edit, and delete files - all persisted in SQLite via a Durable Object, using standard `node:fs/promises` APIs.

## Packages

| Package | Description |
|---------|-------------|
| [`worker-fs-mount`](./packages/worker-fs-mount) | Main package - drop-in replacement for `node:fs/promises` with mount support |
| [`durable-object-fs`](./packages/durable-object-fs) | Durable Object implementing a filesystem with SQLite storage |
| [`r2-fs`](./packages/r2-fs) | R2-backed filesystem for large file storage |
| [`memory-fs`](./packages/memory-fs) | In-memory filesystem for ephemeral/testing use |

## Quick Start

```bash
npm install worker-fs-mount
```

Add the alias to your `wrangler.toml`:

```toml
[alias]
"node:fs/promises" = "worker-fs-mount/fs"
```

Use it in your worker:

```typescript
import { env } from 'cloudflare:workers';
import { mount } from 'worker-fs-mount';
import fs from 'node:fs/promises';

// Mount at module level using importable env
mount('/mnt/storage', env.STORAGE_SERVICE);

export default {
  async fetch(request) {
    // Standard fs operations work automatically
    await fs.writeFile('/mnt/storage/data.json', JSON.stringify({ hello: 'world' }));
    const content = await fs.readFile('/mnt/storage/data.json', 'utf8');

    return new Response(content);
  }
};
```

See the [main package README](./packages/worker-fs-mount/README.md) for full documentation.

## Development

```bash
pnpm install    # Install dependencies
pnpm build      # Build packages
pnpm test       # Run tests
pnpm typecheck  # Type check
```

## License

MIT
