import type { Mount, MountHandle, MountMatch, WorkerFilesystem } from './types.js';

/**
 * Global mount registry.
 * Maps normalized mount paths to their mount configurations.
 */
const mounts = new Map<string, Mount>();

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
    if (path === reserved || path.startsWith(reserved + '/')) {
      throw new Error(`Cannot mount over reserved path: ${reserved}`);
    }
  }
}

/**
 * Mount a WorkerFilesystem at the specified path.
 *
 * @param path - The mount point (must be absolute, starting with /)
 * @param stub - The WorkerFilesystem implementation to mount
 * @returns A MountHandle to manage the mount lifecycle
 *
 * @example
 * ```typescript
 * import { mount } from '@cloudflare/worker-fs-mount';
 *
 * const handle = mount('/mnt/storage', env.STORAGE_SERVICE);
 * // ... use fs operations ...
 * handle.unmount();
 * ```
 */
export function mount(path: string, stub: WorkerFilesystem): MountHandle {
  const normalized = normalizePath(path);

  validateMountPath(normalized);

  if (mounts.has(normalized)) {
    throw new Error(`Path already mounted: ${normalized}`);
  }

  // Check for overlapping mounts
  for (const existing of mounts.keys()) {
    if (normalized.startsWith(existing + '/')) {
      throw new Error(
        `Cannot mount at ${normalized}: parent path ${existing} is already mounted`
      );
    }
    if (existing.startsWith(normalized + '/')) {
      throw new Error(
        `Cannot mount at ${normalized}: child path ${existing} is already mounted`
      );
    }
  }

  mounts.set(normalized, { path: normalized, stub });

  return {
    path: normalized,
    unmount() {
      mounts.delete(normalized);
    },
  };
}

/**
 * Find the mount that handles a given path.
 *
 * @param path - The path to look up
 * @returns The mount and relative path within that mount, or null if not mounted
 */
export function findMount(path: string): MountMatch | null {
  const normalized = normalizePath(path);

  for (const [mountPath, mountData] of mounts) {
    if (normalized === mountPath) {
      return { mount: mountData, relativePath: '/' };
    }
    if (normalized.startsWith(mountPath + '/')) {
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
 * Get all active mounts.
 *
 * @returns Array of mount paths
 */
export function getMounts(): string[] {
  return Array.from(mounts.keys());
}

/**
 * Clear all mounts. Primarily for testing.
 */
export function clearMounts(): void {
  mounts.clear();
}
