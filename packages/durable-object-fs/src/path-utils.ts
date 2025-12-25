/**
 * Normalize a path by collapsing multiple slashes and removing trailing slashes.
 * @param path - The path to normalize
 * @returns The normalized path, always starting with /
 */
export function normalizePath(path: string): string {
  // Collapse multiple slashes into one
  let normalized = path.replace(/\/+/g, '/');
  // Remove trailing slash unless it's the root
  if (normalized !== '/' && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  // Ensure path starts with /
  if (!normalized.startsWith('/')) {
    normalized = `/${normalized}`;
  }
  return normalized;
}

/**
 * Get the parent directory path.
 * @param path - The path to get the parent of
 * @returns The parent path, or / for root-level paths
 */
export function getParentPath(path: string): string {
  const normalized = normalizePath(path);
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash <= 0) return '/';
  return normalized.slice(0, lastSlash);
}

/**
 * Get the base name (file or directory name) from a path.
 * @param path - The path to get the base name from
 * @returns The base name
 */
export function getBaseName(path: string): string {
  const normalized = normalizePath(path);
  const lastSlash = normalized.lastIndexOf('/');
  return normalized.slice(lastSlash + 1);
}

/**
 * Resolve a potentially relative path against a base directory.
 * @param basePath - The base directory path
 * @param relativePath - The relative path to resolve
 * @returns The resolved absolute path
 */
export function resolvePath(basePath: string, relativePath: string): string {
  if (relativePath.startsWith('/')) {
    return normalizePath(relativePath);
  }
  return normalizePath(`${basePath}/${relativePath}`);
}
