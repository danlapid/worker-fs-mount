import { WorkerEntrypoint } from 'cloudflare:workers';
import type { DirEntry, Stat, WorkerFilesystem } from 'worker-fs-mount';

/**
 * A file node in the in-memory filesystem.
 */
interface FileNode {
  type: 'file';
  content: Uint8Array;
  lastModified: Date;
  created: Date;
}

/**
 * A directory node in the in-memory filesystem.
 */
interface DirectoryNode {
  type: 'directory';
  lastModified: Date;
  created: Date;
}

/**
 * A symbolic link node in the in-memory filesystem.
 */
interface SymlinkNode {
  type: 'symlink';
  target: string;
  lastModified: Date;
  created: Date;
}

/**
 * A node in the in-memory filesystem.
 */
type FsNode = FileNode | DirectoryNode | SymlinkNode;

/**
 * The state backing the in-memory filesystem.
 */
type MemoryFilesystemState = Map<string, FsNode>;

/**
 * Error codes used by the filesystem.
 */
type FsErrorCode = 'ENOENT' | 'EEXIST' | 'EISDIR' | 'ENOTDIR' | 'ENOTEMPTY' | 'EINVAL' | 'ELOOP';

/**
 * Create a filesystem error with a POSIX-style error code.
 */
function createFsError(code: FsErrorCode, path: string): Error {
  const messages: Record<FsErrorCode, string> = {
    ENOENT: 'no such file or directory',
    EEXIST: 'file already exists',
    EISDIR: 'illegal operation on a directory',
    ENOTDIR: 'not a directory',
    ENOTEMPTY: 'directory not empty',
    EINVAL: 'invalid argument',
    ELOOP: 'too many symbolic links',
  };
  return new Error(`${code}: ${messages[code]}, '${path}'`);
}

/**
 * Normalize a path by collapsing multiple slashes and removing trailing slashes.
 */
function normalizePath(path: string): string {
  let normalized = path.replace(/\/+/g, '/');
  if (normalized !== '/' && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  if (!normalized.startsWith('/')) {
    normalized = `/${normalized}`;
  }
  return normalized;
}

/**
 * Get the parent directory path.
 */
function getParentPath(path: string): string {
  const normalized = normalizePath(path);
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash <= 0) return '/';
  return normalized.slice(0, lastSlash);
}

/**
 * Create a new, empty filesystem state with just a root directory.
 */
function createMemoryFilesystemState(): MemoryFilesystemState {
  const state: MemoryFilesystemState = new Map();
  const now = new Date();
  state.set('/', {
    type: 'directory',
    lastModified: now,
    created: now,
  });
  return state;
}

/**
 * Reset a filesystem state to empty (just root directory).
 */
function resetMemoryFilesystemState(state: MemoryFilesystemState): void {
  state.clear();
  const now = new Date();
  state.set('/', {
    type: 'directory',
    lastModified: now,
    created: now,
  });
}

/**
 * An in-memory filesystem WorkerEntrypoint.
 * Re-export this class from your worker to make it available via ctx.exports.
 *
 * @example
 * ```typescript
 * import { MemoryFilesystem } from 'memory-fs';
 * import { mount, withMounts } from 'worker-fs-mount';
 * import fs from 'node:fs/promises';
 *
 * // Re-export to make available via ctx.exports
 * export { MemoryFilesystem };
 *
 * export default {
 *   async fetch(request: Request, env: Env, ctx: ExecutionContext) {
 *     return withMounts(async () => {
 *       mount('/mem', ctx.exports.MemoryFilesystem);
 *       await fs.writeFile('/mem/hello.txt', 'Hello!');
 *       return new Response(await fs.readFile('/mem/hello.txt', 'utf8'));
 *     });
 *   }
 * }
 * ```
 */
export class MemoryFilesystem extends WorkerEntrypoint implements WorkerFilesystem {
  private static sharedState: MemoryFilesystemState = createMemoryFilesystemState();
  private readonly nodes: MemoryFilesystemState = MemoryFilesystem.sharedState;

  /**
   * Reset the shared filesystem state. Useful for testing.
   */
  static resetState(): void {
    resetMemoryFilesystemState(MemoryFilesystem.sharedState);
  }

  private resolveSymlink(path: string, depth = 0): string {
    if (depth > 40) throw createFsError('ELOOP', path);
    const node = this.nodes.get(normalizePath(path));
    if (node?.type === 'symlink') {
      const target = node.target.startsWith('/')
        ? node.target
        : normalizePath(`${getParentPath(path)}/${node.target}`);
      return this.resolveSymlink(target, depth + 1);
    }
    return normalizePath(path);
  }

  // === Metadata Operations ===

  async stat(path: string, options?: { followSymlinks?: boolean }): Promise<Stat | null> {
    let normalized = normalizePath(path);

    if (options?.followSymlinks !== false) {
      try {
        normalized = this.resolveSymlink(normalized);
      } catch {
        return null;
      }
    }

    const node = this.nodes.get(normalized);
    if (!node) return null;

    if (node.type === 'file') {
      return {
        type: 'file',
        size: node.content.length,
        lastModified: node.lastModified,
        created: node.created,
        writable: true,
      };
    } else if (node.type === 'directory') {
      return {
        type: 'directory',
        size: 0,
        lastModified: node.lastModified,
        created: node.created,
        writable: true,
      };
    } else {
      return {
        type: 'symlink',
        size: node.target.length,
        lastModified: node.lastModified,
        created: node.created,
        writable: true,
      };
    }
  }

  async setLastModified(path: string, mtime: Date): Promise<void> {
    const normalized = normalizePath(path);
    const node = this.nodes.get(normalized);
    if (!node) {
      throw createFsError('ENOENT', path);
    }
    node.lastModified = mtime;
  }

  // === File Operations (Whole File) ===

  async readFile(path: string): Promise<Uint8Array> {
    const normalized = this.resolveSymlink(path);
    const node = this.nodes.get(normalized);
    if (!node) {
      throw createFsError('ENOENT', path);
    }
    if (node.type !== 'file') {
      throw createFsError('EISDIR', path);
    }
    return node.content;
  }

  async writeFile(
    path: string,
    data: Uint8Array,
    options?: { append?: boolean; exclusive?: boolean }
  ): Promise<number> {
    const normalized = normalizePath(path);
    const existing = this.nodes.get(normalized);

    if (options?.exclusive && existing) {
      throw createFsError('EEXIST', path);
    }

    // Check parent directory exists
    const parentPath = getParentPath(normalized);
    const parent = this.nodes.get(parentPath);
    if (!parent || parent.type !== 'directory') {
      throw createFsError('ENOENT', parentPath);
    }

    if (existing && existing.type === 'directory') {
      throw createFsError('EISDIR', path);
    }

    const now = new Date();
    if (options?.append && existing && existing.type === 'file') {
      const newContent = new Uint8Array(existing.content.length + data.length);
      newContent.set(existing.content, 0);
      newContent.set(data, existing.content.length);
      existing.content = newContent;
      existing.lastModified = now;
      return data.length;
    }

    this.nodes.set(normalized, {
      type: 'file',
      content: data,
      lastModified: now,
      created: existing?.created ?? now,
    });

    return data.length;
  }

  // === File Operations (Chunked) ===

  async read(path: string, options: { offset: number; length: number }): Promise<Uint8Array> {
    const content = await this.readFile(path);
    return content.slice(options.offset, options.offset + options.length);
  }

  async write(path: string, data: Uint8Array, options: { offset: number }): Promise<number> {
    const normalized = normalizePath(path);
    const node = this.nodes.get(normalized);
    if (!node) {
      throw createFsError('ENOENT', path);
    }
    if (node.type !== 'file') {
      throw createFsError('EISDIR', path);
    }

    const newLength = Math.max(node.content.length, options.offset + data.length);
    const newContent = new Uint8Array(newLength);
    newContent.set(node.content, 0);
    newContent.set(data, options.offset);
    node.content = newContent;
    node.lastModified = new Date();
    return data.length;
  }

  // === File Operations (Streaming) ===

  async createReadStream(
    path: string,
    options?: { start?: number; end?: number }
  ): Promise<ReadableStream<Uint8Array>> {
    const content = await this.readFile(path);
    const start = options?.start ?? 0;
    const end = options?.end ?? content.length;
    const chunk = content.slice(start, end);

    return new ReadableStream({
      start(controller) {
        controller.enqueue(chunk);
        controller.close();
      },
    });
  }

  async createWriteStream(
    path: string,
    options?: { start?: number; flags?: 'w' | 'a' | 'r+' }
  ): Promise<WritableStream<Uint8Array>> {
    const normalized = normalizePath(path);
    const self = this;
    let offset = options?.start ?? 0;

    // Initialize file if needed
    if (options?.flags !== 'r+') {
      const existing = this.nodes.get(normalized);
      if (!existing || options?.flags === 'w') {
        await this.writeFile(path, new Uint8Array(0));
      }
      if (options?.flags === 'a' && existing?.type === 'file') {
        offset = existing.content.length;
      }
    }

    return new WritableStream({
      async write(chunk) {
        await self.write(path, chunk, { offset });
        offset += chunk.length;
      },
    });
  }

  // === Other File Operations ===

  async truncate(path: string, length = 0): Promise<void> {
    const normalized = normalizePath(path);
    const node = this.nodes.get(normalized);
    if (!node) {
      throw createFsError('ENOENT', path);
    }
    if (node.type !== 'file') {
      throw createFsError('EISDIR', path);
    }

    if (length < node.content.length) {
      node.content = node.content.slice(0, length);
    } else if (length > node.content.length) {
      const newContent = new Uint8Array(length);
      newContent.set(node.content, 0);
      node.content = newContent;
    }
    node.lastModified = new Date();
  }

  // === Directory Operations ===

  async readdir(path: string, options?: { recursive?: boolean }): Promise<DirEntry[]> {
    const normalized = normalizePath(path);
    const node = this.nodes.get(normalized);
    if (!node) {
      throw createFsError('ENOENT', path);
    }
    if (node.type !== 'directory') {
      throw createFsError('ENOTDIR', path);
    }

    const prefix = normalized === '/' ? '/' : `${normalized}/`;
    const entries: DirEntry[] = [];
    const seen = new Set<string>();

    for (const [nodePath, nodeValue] of this.nodes) {
      if (nodePath === normalized) continue;
      if (!nodePath.startsWith(prefix)) continue;

      const relativePath = nodePath.slice(prefix.length);
      if (!options?.recursive) {
        // Only direct children
        if (relativePath.includes('/')) continue;
      }

      const name = options?.recursive ? relativePath : relativePath.split('/')[0]!;
      if (seen.has(name)) continue;
      seen.add(name);

      entries.push({
        name,
        type: nodeValue.type,
      });
    }

    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined> {
    const normalized = normalizePath(path);

    if (this.nodes.has(normalized)) {
      if (options?.recursive) return undefined;
      throw createFsError('EEXIST', path);
    }

    const parentPath = getParentPath(normalized);
    const parent = this.nodes.get(parentPath);

    if (!parent) {
      if (options?.recursive) {
        await this.mkdir(parentPath, { recursive: true });
      } else {
        throw createFsError('ENOENT', parentPath);
      }
    }

    const now = new Date();
    this.nodes.set(normalized, {
      type: 'directory',
      lastModified: now,
      created: now,
    });

    return normalized;
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const normalized = normalizePath(path);
    const node = this.nodes.get(normalized);

    if (!node) {
      if (options?.force) return;
      throw createFsError('ENOENT', path);
    }

    if (node.type === 'directory') {
      // Check if directory is empty
      const prefix = normalized === '/' ? '/' : `${normalized}/`;
      const hasChildren = Array.from(this.nodes.keys()).some(
        (p) => p !== normalized && p.startsWith(prefix)
      );

      if (hasChildren) {
        if (!options?.recursive) {
          throw createFsError('ENOTEMPTY', path);
        }
        // Remove all children
        for (const p of this.nodes.keys()) {
          if (p.startsWith(prefix)) {
            this.nodes.delete(p);
          }
        }
      }
    }

    this.nodes.delete(normalized);
  }

  // === Link Operations ===

  async symlink(linkPath: string, targetPath: string): Promise<void> {
    const normalized = normalizePath(linkPath);

    if (this.nodes.has(normalized)) {
      throw createFsError('EEXIST', linkPath);
    }

    const parentPath = getParentPath(normalized);
    const parent = this.nodes.get(parentPath);
    if (!parent || parent.type !== 'directory') {
      throw createFsError('ENOENT', parentPath);
    }

    const now = new Date();
    this.nodes.set(normalized, {
      type: 'symlink',
      target: targetPath,
      lastModified: now,
      created: now,
    });
  }

  async readlink(path: string): Promise<string> {
    const normalized = normalizePath(path);
    const node = this.nodes.get(normalized);
    if (!node) {
      throw createFsError('ENOENT', path);
    }
    if (node.type !== 'symlink') {
      throw createFsError('EINVAL', path);
    }
    return node.target;
  }

  async unlink(path: string): Promise<void> {
    const normalized = normalizePath(path);
    const node = this.nodes.get(normalized);
    if (!node) {
      throw createFsError('ENOENT', path);
    }
    if (node.type === 'directory') {
      throw createFsError('EISDIR', path);
    }
    this.nodes.delete(normalized);
  }

  // === Copy/Move Operations ===

  async rename(oldPath: string, newPath: string): Promise<void> {
    const normalizedOld = normalizePath(oldPath);
    const normalizedNew = normalizePath(newPath);

    const node = this.nodes.get(normalizedOld);
    if (!node) {
      throw createFsError('ENOENT', oldPath);
    }

    const newParent = getParentPath(normalizedNew);
    if (!this.nodes.has(newParent)) {
      throw createFsError('ENOENT', newParent);
    }

    // Move the node
    this.nodes.delete(normalizedOld);
    this.nodes.set(normalizedNew, node);
    node.lastModified = new Date();

    // If directory, move all children
    if (node.type === 'directory') {
      const oldPrefix = `${normalizedOld}/`;
      const newPrefix = `${normalizedNew}/`;
      const toMove: [string, FsNode][] = [];

      for (const [p, n] of this.nodes) {
        if (p.startsWith(oldPrefix)) {
          toMove.push([p, n]);
        }
      }

      for (const [p, n] of toMove) {
        this.nodes.delete(p);
        this.nodes.set(newPrefix + p.slice(oldPrefix.length), n);
      }
    }
  }

  async cp(src: string, dest: string, options?: { recursive?: boolean }): Promise<void> {
    const normalizedSrc = normalizePath(src);
    const normalizedDest = normalizePath(dest);

    const srcNode = this.nodes.get(normalizedSrc);
    if (!srcNode) {
      throw createFsError('ENOENT', src);
    }

    if (srcNode.type === 'file') {
      await this.writeFile(dest, srcNode.content);
    } else if (srcNode.type === 'directory') {
      if (!options?.recursive) {
        throw createFsError('EISDIR', src);
      }

      await this.mkdir(dest, { recursive: true });

      const srcPrefix = normalizedSrc === '/' ? '/' : `${normalizedSrc}/`;
      for (const [p, n] of this.nodes) {
        if (p.startsWith(srcPrefix)) {
          const relativePath = p.slice(srcPrefix.length);
          const destPath = `${normalizedDest}/${relativePath}`;
          if (n.type === 'file') {
            await this.writeFile(destPath, n.content);
          } else if (n.type === 'directory') {
            await this.mkdir(destPath, { recursive: true });
          }
        }
      }
    } else if (srcNode.type === 'symlink') {
      await this.symlink(dest, srcNode.target);
    }
  }

  async access(path: string, _mode?: number): Promise<void> {
    const normalized = normalizePath(path);
    const node = this.nodes.get(normalized);
    if (!node) {
      throw createFsError('ENOENT', path);
    }
  }
}
