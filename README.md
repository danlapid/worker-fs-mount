# worker-fs-mount

Mount WorkerEntrypoints as virtual filesystems in Cloudflare Workers.

## Packages

| Package | Description |
|---------|-------------|
| [`worker-fs-mount`](./packages/worker-fs-mount) | Main package - drop-in replacement for `node:fs/promises` with mount support |

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
import { mount } from 'worker-fs-mount';
import fs from 'node:fs/promises';

export default {
  async fetch(request, env) {
    // Mount a service binding as a filesystem
    mount('/mnt/storage', env.STORAGE_SERVICE);

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
