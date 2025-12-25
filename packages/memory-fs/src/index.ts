import { WorkerEntrypoint } from 'cloudflare:workers';
import type { DirEntry, Stat, WorkerFilesystem } from 'worker-fs-mount';
import { createFsError, getParentPath, normalizePath } from 'worker-fs-mount/utils';

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
 * import { mount } from 'worker-fs-mount';
 * import { exports } from 'cloudflare:workers';
 * import fs from 'node:fs/promises';
 *
 * // Re-export to make available via exports
 * export { MemoryFilesystem };
 *
 * // Mount at module level
 * mount('/mem', exports.MemoryFilesystem);
 *
 * export default {
 *   async fetch(request: Request) {
 *     await fs.writeFile('/mem/hello.txt', 'Hello!');
 *     return new Response(await fs.readFile('/mem/hello.txt', 'utf8'));
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

  // === Streaming Operations ===

  async createReadStream(
    path: string,
    options?: { start?: number; end?: number }
  ): Promise<ReadableStream<Uint8Array>> {
    const normalized = this.resolveSymlink(path);
    const node = this.nodes.get(normalized);
    if (!node) {
      throw createFsError('ENOENT', path);
    }
    if (node.type !== 'file') {
      throw createFsError('EISDIR', path);
    }

    const content = node.content;
    const start = options?.start ?? 0;
    const end = options?.end !== undefined ? options.end + 1 : content.length;
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

    // Check parent directory exists
    const parentPath = getParentPath(normalized);
    const parent = this.nodes.get(parentPath);
    if (!parent || parent.type !== 'directory') {
      throw createFsError('ENOENT', parentPath);
    }

    const existing = this.nodes.get(normalized);
    if (existing && existing.type === 'directory') {
      throw createFsError('EISDIR', path);
    }

    // Initialize or get existing file
    let fileNode: FileNode;
    const now = new Date();

    if (options?.flags === 'r+') {
      // Read-write mode: file must exist
      if (!existing || existing.type !== 'file') {
        throw createFsError('ENOENT', path);
      }
      fileNode = existing;
    } else if (options?.flags === 'a') {
      // Append mode: create if doesn't exist, set offset to end
      if (existing && existing.type === 'file') {
        fileNode = existing;
        offset = existing.content.length;
      } else {
        fileNode = {
          type: 'file',
          content: new Uint8Array(0),
          lastModified: now,
          created: now,
        };
        this.nodes.set(normalized, fileNode);
      }
    } else {
      // Write mode (default): create or truncate
      fileNode = {
        type: 'file',
        content: new Uint8Array(0),
        lastModified: now,
        created: existing?.created ?? now,
      };
      this.nodes.set(normalized, fileNode);
    }

    return new WritableStream({
      write(chunk) {
        const node = self.nodes.get(normalized) as FileNode;
        const newLength = Math.max(node.content.length, offset + chunk.length);
        const newContent = new Uint8Array(newLength);
        newContent.set(node.content, 0);
        newContent.set(chunk, offset);
        node.content = newContent;
        node.lastModified = new Date();
        offset += chunk.length;
      },
    });
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

      const name = options?.recursive ? relativePath : (relativePath.split('/')[0] ?? '');
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
}
