/**
 * worker-fs-mount
 *
 * Mount WorkerEntrypoints as virtual filesystems in Cloudflare Workers.
 *
 * ## Setup
 *
 * Add the following alias to your wrangler.toml:
 *
 * ```toml
 * [alias]
 * "node:fs/promises" = "worker-fs-mount/fs"
 * ```
 *
 * ## Usage
 *
 * ```typescript
 * import { withMounts, mount } from 'worker-fs-mount';
 * import fs from 'node:fs/promises';
 *
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     return withMounts(async () => {
 *       // Mount a WorkerEntrypoint (scoped to this request)
 *       mount('/mnt/storage', env.STORAGE_SERVICE);
 *
 *       // Use standard fs operations - they're automatically intercepted
 *       await fs.writeFile('/mnt/storage/file.txt', 'Hello, World!');
 *       const content = await fs.readFile('/mnt/storage/file.txt', 'utf8');
 *
 *       return new Response(content);
 *     }); // Mounts automatically cleaned up
 *   }
 * };
 * ```
 *
 * @packageDocumentation
 */

// Export public API
export {
  withMounts,
  mount,
  unmount,
  isMounted,
  isInMountContext,
} from './registry.js';

// Export types
export type { WorkerFilesystem, Stat, DirEntry } from './types.js';
