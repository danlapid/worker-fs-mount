import { AsyncLocalStorage } from 'node:async_hooks';
import type { WorkerFilesystem } from './types.js';

/**
 * Internal mount structure.
 */
interface Mount {
  path: string;
  stub: WorkerFilesystem;
}

/**
 * Result of finding a mount for a path.
 */
interface MountMatch {
  mount: Mount;
  relativePath: string;
}

/**
 * AsyncLocalStorage for request-scoped mounts.
 * Each request can have its own isolated mount registry.
 */
const mountStorage = new AsyncLocalStorage<Map<string, Mount>>();

/**
 * Global mount registry (fallback for backwards compatibility).
 * Used when mount() is called outside of withMounts().
 */
const globalMounts = new Map<string, Mount>();

/**
 * Get the current mount registry (request-scoped or global fallback).
 */
function getMountRegistry(): Map<string, Mount> {
  return mountStorage.getStore() ?? globalMounts;
}

/**
 * Reserved paths that cannot be mounted over.
 */
const RESERVED_PATHS = ['/bundle', '/tmp', '/dev'];

/**
 * Normalize a path for consistent matching.
 * - Removes trailing slashes (except for root)
 * - Collapses multiple slashes
 * - Resolves . segments
 */
function normalizePath(path: string): string {
  if (!path) return '/';

  // Collapse multiple slashes and remove trailing slash
  let normalized = path.replace(/\/+/g, '/').replace(/\/\.\//g, '/');

  // Remove trailing slash unless it's the root
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }

  return normalized || '/';
}

/**
 * Validate a mount path.
 * @throws If the path is invalid
 */
function validateMountPath(path: string): void {
  if (!path.startsWith('/')) {
    throw new Error(`Mount path must be absolute (start with /): ${path}`);
  }

  // Check reserved paths
  for (const reserved of RESERVED_PATHS) {
    if (path === reserved || path.startsWith(`${reserved}/`)) {
      throw new Error(`Cannot mount over reserved path: ${reserved}`);
    }
  }
}

/**
 * Run a function with an isolated mount context.
 * Mounts created within the callback are scoped to that request
 * and automatically cleaned up when the callback completes.
 *
 * @param fn - The function to run with isolated mounts
 * @returns The result of the function
 *
 * @example
 * ```typescript
 * import { withMounts, mount } from 'worker-fs-mount';
 * import fs from 'node:fs/promises';
 *
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     return withMounts(async () => {
 *       const id = env.FILESYSTEM.idFromName('user-123');
 *       mount('/data', env.FILESYSTEM.get(id));
 *
 *       const content = await fs.readFile('/data/file.txt', 'utf8');
 *       return new Response(content);
 *     });
 *   }
 * };
 * ```
 */
export function withMounts<T>(fn: () => T): T {
  const requestMounts = new Map<string, Mount>();
  return mountStorage.run(requestMounts, fn);
}

/**
 * Mount a WorkerFilesystem at the specified path.
 *
 * When called within withMounts(), the mount is scoped to that context.
 * When called outside withMounts(), uses a global registry (for backwards compatibility).
 *
 * @param path - The mount point (must be absolute, starting with /)
 * @param stub - The WorkerFilesystem implementation to mount
 *
 * @example
 * ```typescript
 * import { withMounts, mount } from 'worker-fs-mount';
 *
 * // Recommended: use withMounts for request isolation
 * withMounts(() => {
 *   mount('/mnt/storage', env.STORAGE_SERVICE);
 *   // ... use fs operations ...
 * });
 * ```
 */
export function mount(path: string, stub: WorkerFilesystem): void {
  const mounts = getMountRegistry();
  const normalized = normalizePath(path);

  validateMountPath(normalized);

  if (mounts.has(normalized)) {
    throw new Error(`Path already mounted: ${normalized}`);
  }

  // Check for overlapping mounts
  for (const existing of mounts.keys()) {
    if (normalized.startsWith(`${existing}/`)) {
      throw new Error(`Cannot mount at ${normalized}: parent path ${existing} is already mounted`);
    }
    if (existing.startsWith(`${normalized}/`)) {
      throw new Error(`Cannot mount at ${normalized}: child path ${existing} is already mounted`);
    }
  }

  mounts.set(normalized, { path: normalized, stub });
}

/**
 * Unmount a filesystem at the specified path.
 *
 * @param path - The mount point to unmount
 * @returns True if a mount was removed, false if nothing was mounted at that path
 *
 * @example
 * ```typescript
 * import { mount, unmount } from 'worker-fs-mount';
 *
 * mount('/mnt/storage', env.STORAGE_SERVICE);
 * // ... use fs operations ...
 * unmount('/mnt/storage');
 * ```
 */
export function unmount(path: string): boolean {
  const mounts = getMountRegistry();
  const normalized = normalizePath(path);
  return mounts.delete(normalized);
}

/**
 * Find the mount that handles a given path.
 *
 * @param path - The path to look up
 * @returns The mount and relative path within that mount, or null if not mounted
 */
export function findMount(path: string): MountMatch | null {
  const mounts = getMountRegistry();
  const normalized = normalizePath(path);

  for (const [mountPath, mountData] of mounts) {
    if (normalized === mountPath) {
      return { mount: mountData, relativePath: '/' };
    }
    if (normalized.startsWith(`${mountPath}/`)) {
      return {
        mount: mountData,
        relativePath: normalized.slice(mountPath.length),
      };
    }
  }

  return null;
}

/**
 * Check if a path is under any mount.
 *
 * @param path - The path to check
 * @returns True if the path is mounted
 */
export function isMounted(path: string): boolean {
  return findMount(path) !== null;
}

/**
 * Check if currently running within a withMounts() context.
 *
 * @returns True if in a request-scoped context, false if using global registry
 */
export function isInMountContext(): boolean {
  return mountStorage.getStore() !== undefined;
}
