/**
 * @cloudflare/worker-fs-mount
 *
 * Mount WorkerEntrypoints as virtual filesystems in Cloudflare Workers.
 *
 * ## Setup
 *
 * Add the following alias to your wrangler.toml:
 *
 * ```toml
 * [alias]
 * "node:fs/promises" = "@cloudflare/worker-fs-mount/fs"
 * ```
 *
 * ## Usage
 *
 * ```typescript
 * import { mount } from '@cloudflare/worker-fs-mount';
 * import fs from 'node:fs/promises';
 *
 * // Mount a WorkerEntrypoint
 * const handle = mount('/mnt/storage', env.STORAGE_SERVICE);
 *
 * // Use standard fs operations - they're automatically intercepted
 * await fs.writeFile('/mnt/storage/file.txt', 'Hello, World!');
 * const content = await fs.readFile('/mnt/storage/file.txt', 'utf8');
 *
 * // Unmount when done
 * handle.unmount();
 * ```
 *
 * @packageDocumentation
 */

// Export mount functions
export { mount, findMount, isMounted, getMounts, clearMounts } from './registry.js';

// Export types
export type {
  WorkerFilesystem,
  Stat,
  DirEntry,
  MountHandle,
  Mount,
  MountMatch,
} from './types.js';
