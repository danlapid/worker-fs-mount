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
 * import { mount } from 'worker-fs-mount';
 * import fs from 'node:fs/promises';
 *
 * // Mount a WorkerEntrypoint
 * mount('/mnt/storage', env.STORAGE_SERVICE);
 *
 * // Use standard fs operations - they're automatically intercepted
 * await fs.writeFile('/mnt/storage/file.txt', 'Hello, World!');
 * const content = await fs.readFile('/mnt/storage/file.txt', 'utf8');
 *
 * // Unmount when done
 * unmount('/mnt/storage');
 * ```
 *
 * @packageDocumentation
 */

// Export public API
export { mount, unmount, isMounted } from './registry.js';

// Export types
export type { WorkerFilesystem, Stat, DirEntry } from './types.js';
