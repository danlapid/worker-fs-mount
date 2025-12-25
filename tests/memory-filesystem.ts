import { WorkerEntrypoint } from 'cloudflare:workers';
import type { WorkerFilesystem, Stat, DirEntry } from '../src/types.js';

interface FileNode {
  type: 'file';
  content: Uint8Array;
  lastModified: Date;
  created: Date;
}

interface DirectoryNode {
  type: 'directory';
  lastModified: Date;
  created: Date;
}

interface SymlinkNode {
  type: 'symlink';
  target: string;
  lastModified: Date;
  created: Date;
}

type FsNode = FileNode | DirectoryNode | SymlinkNode;

// Module-level state shared across all instances of MemoryFilesystem
// This simulates persistent storage that survives across jsrpc calls
const nodes: Map<string, FsNode> = new Map([
  [
    '/',
    {
      type: 'directory',
      lastModified: new Date(),
      created: new Date(),
    },
  ],
]);

/**
 * Reset the filesystem state - called between tests
 */
export function resetMemoryFilesystem(): void {
  nodes.clear();
  nodes.set('/', {
    type: 'directory',
    lastModified: new Date(),
    created: new Date(),
  });
}

/**
 * In-memory filesystem implementation as a WorkerEntrypoint.
 * Implements the full WorkerFilesystem interface.
 * Uses module-level state to persist data across jsrpc calls.
 */
export class MemoryFilesystem extends WorkerEntrypoint implements WorkerFilesystem {
  private normalizePath(path: string): string {
    // Remove leading slashes and normalize
    let normalized = path.replace(/\/+/g, '/');
    if (normalized !== '/' && normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }
    if (!normalized.startsWith('/')) {
      normalized = '/' + normalized;
    }
    return normalized;
  }

  private getParentPath(path: string): string {
    const normalized = this.normalizePath(path);
    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash <= 0) return '/';
    return normalized.slice(0, lastSlash);
  }

  private getBaseName(path: string): string {
    const normalized = this.normalizePath(path);
    const lastSlash = normalized.lastIndexOf('/');
    return normalized.slice(lastSlash + 1);
  }

  private resolveSymlink(path: string, depth = 0): string {
    if (depth > 40) throw new Error('ELOOP: too many symbolic links');
    const node = nodes.get(this.normalizePath(path));
    if (node?.type === 'symlink') {
      const target = node.target.startsWith('/')
        ? node.target
        : this.normalizePath(this.getParentPath(path) + '/' + node.target);
      return this.resolveSymlink(target, depth + 1);
    }
    return this.normalizePath(path);
  }

  async stat(path: string, options?: { followSymlinks?: boolean }): Promise<Stat | null> {
    let normalized = this.normalizePath(path);

    if (options?.followSymlinks !== false) {
      try {
        normalized = this.resolveSymlink(normalized);
      } catch {
        return null;
      }
    }

    const node = nodes.get(normalized);
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
    const normalized = this.normalizePath(path);
    const node = nodes.get(normalized);
    if (!node) {
      throw new Error(`ENOENT: no such file or directory, '${path}'`);
    }
    node.lastModified = mtime;
  }

  async readFile(path: string): Promise<Uint8Array> {
    const normalized = this.resolveSymlink(path);
    const node = nodes.get(normalized);
    if (!node) {
      throw new Error(`ENOENT: no such file or directory, '${path}'`);
    }
    if (node.type !== 'file') {
      throw new Error(`EISDIR: illegal operation on a directory, '${path}'`);
    }
    return node.content;
  }

  async writeFile(
    path: string,
    data: Uint8Array,
    options?: { append?: boolean; exclusive?: boolean }
  ): Promise<number> {
    const normalized = this.normalizePath(path);
    const existing = nodes.get(normalized);

    if (options?.exclusive && existing) {
      throw new Error(`EEXIST: file already exists, '${path}'`);
    }

    // Check parent directory exists
    const parentPath = this.getParentPath(normalized);
    const parent = nodes.get(parentPath);
    if (!parent || parent.type !== 'directory') {
      throw new Error(`ENOENT: no such file or directory, '${parentPath}'`);
    }

    if (existing && existing.type === 'directory') {
      throw new Error(`EISDIR: illegal operation on a directory, '${path}'`);
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

    nodes.set(normalized, {
      type: 'file',
      content: data,
      lastModified: now,
      created: existing?.created ?? now,
    });

    return data.length;
  }

  async read(path: string, options: { offset: number; length: number }): Promise<Uint8Array> {
    const content = await this.readFile(path);
    return content.slice(options.offset, options.offset + options.length);
  }

  async write(path: string, data: Uint8Array, options: { offset: number }): Promise<number> {
    const normalized = this.normalizePath(path);
    const node = nodes.get(normalized);
    if (!node) {
      throw new Error(`ENOENT: no such file or directory, '${path}'`);
    }
    if (node.type !== 'file') {
      throw new Error(`EISDIR: illegal operation on a directory, '${path}'`);
    }

    const newLength = Math.max(node.content.length, options.offset + data.length);
    const newContent = new Uint8Array(newLength);
    newContent.set(node.content, 0);
    newContent.set(data, options.offset);
    node.content = newContent;
    node.lastModified = new Date();
    return data.length;
  }

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
    const normalized = this.normalizePath(path);
    const self = this;
    let offset = options?.start ?? 0;

    // Initialize file if needed
    if (options?.flags !== 'r+') {
      const existing = nodes.get(normalized);
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

  async truncate(path: string, length = 0): Promise<void> {
    const normalized = this.normalizePath(path);
    const node = nodes.get(normalized);
    if (!node) {
      throw new Error(`ENOENT: no such file or directory, '${path}'`);
    }
    if (node.type !== 'file') {
      throw new Error(`EISDIR: illegal operation on a directory, '${path}'`);
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

  async readdir(path: string, options?: { recursive?: boolean }): Promise<DirEntry[]> {
    const normalized = this.normalizePath(path);
    const node = nodes.get(normalized);
    if (!node) {
      throw new Error(`ENOENT: no such file or directory, '${path}'`);
    }
    if (node.type !== 'directory') {
      throw new Error(`ENOTDIR: not a directory, '${path}'`);
    }

    const prefix = normalized === '/' ? '/' : normalized + '/';
    const entries: DirEntry[] = [];
    const seen = new Set<string>();

    for (const [nodePath, nodeValue] of nodes) {
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
    const normalized = this.normalizePath(path);

    if (nodes.has(normalized)) {
      if (options?.recursive) return undefined;
      throw new Error(`EEXIST: file already exists, '${path}'`);
    }

    const parentPath = this.getParentPath(normalized);
    const parent = nodes.get(parentPath);

    if (!parent) {
      if (options?.recursive) {
        await this.mkdir(parentPath, { recursive: true });
      } else {
        throw new Error(`ENOENT: no such file or directory, '${parentPath}'`);
      }
    }

    const now = new Date();
    nodes.set(normalized, {
      type: 'directory',
      lastModified: now,
      created: now,
    });

    return normalized;
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const normalized = this.normalizePath(path);
    const node = nodes.get(normalized);

    if (!node) {
      if (options?.force) return;
      throw new Error(`ENOENT: no such file or directory, '${path}'`);
    }

    if (node.type === 'directory') {
      // Check if directory is empty
      const prefix = normalized === '/' ? '/' : normalized + '/';
      const hasChildren = Array.from(nodes.keys()).some(
        (p) => p !== normalized && p.startsWith(prefix)
      );

      if (hasChildren) {
        if (!options?.recursive) {
          throw new Error(`ENOTEMPTY: directory not empty, '${path}'`);
        }
        // Remove all children
        for (const p of nodes.keys()) {
          if (p.startsWith(prefix)) {
            nodes.delete(p);
          }
        }
      }
    }

    nodes.delete(normalized);
  }

  async symlink(linkPath: string, targetPath: string): Promise<void> {
    const normalized = this.normalizePath(linkPath);

    if (nodes.has(normalized)) {
      throw new Error(`EEXIST: file already exists, '${linkPath}'`);
    }

    const parentPath = this.getParentPath(normalized);
    const parent = nodes.get(parentPath);
    if (!parent || parent.type !== 'directory') {
      throw new Error(`ENOENT: no such file or directory, '${parentPath}'`);
    }

    const now = new Date();
    nodes.set(normalized, {
      type: 'symlink',
      target: targetPath,
      lastModified: now,
      created: now,
    });
  }

  async readlink(path: string): Promise<string> {
    const normalized = this.normalizePath(path);
    const node = nodes.get(normalized);
    if (!node) {
      throw new Error(`ENOENT: no such file or directory, '${path}'`);
    }
    if (node.type !== 'symlink') {
      throw new Error(`EINVAL: invalid argument, '${path}'`);
    }
    return node.target;
  }

  async unlink(path: string): Promise<void> {
    const normalized = this.normalizePath(path);
    const node = nodes.get(normalized);
    if (!node) {
      throw new Error(`ENOENT: no such file or directory, '${path}'`);
    }
    if (node.type === 'directory') {
      throw new Error(`EISDIR: illegal operation on a directory, '${path}'`);
    }
    nodes.delete(normalized);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const normalizedOld = this.normalizePath(oldPath);
    const normalizedNew = this.normalizePath(newPath);

    const node = nodes.get(normalizedOld);
    if (!node) {
      throw new Error(`ENOENT: no such file or directory, '${oldPath}'`);
    }

    const newParent = this.getParentPath(normalizedNew);
    if (!nodes.has(newParent)) {
      throw new Error(`ENOENT: no such file or directory, '${newParent}'`);
    }

    // Move the node
    nodes.delete(normalizedOld);
    nodes.set(normalizedNew, node);
    node.lastModified = new Date();

    // If directory, move all children
    if (node.type === 'directory') {
      const oldPrefix = normalizedOld + '/';
      const newPrefix = normalizedNew + '/';
      const toMove: [string, FsNode][] = [];

      for (const [p, n] of nodes) {
        if (p.startsWith(oldPrefix)) {
          toMove.push([p, n]);
        }
      }

      for (const [p, n] of toMove) {
        nodes.delete(p);
        nodes.set(newPrefix + p.slice(oldPrefix.length), n);
      }
    }
  }

  async cp(src: string, dest: string, options?: { recursive?: boolean }): Promise<void> {
    const normalizedSrc = this.normalizePath(src);
    const normalizedDest = this.normalizePath(dest);

    const srcNode = nodes.get(normalizedSrc);
    if (!srcNode) {
      throw new Error(`ENOENT: no such file or directory, '${src}'`);
    }

    if (srcNode.type === 'file') {
      await this.writeFile(dest, srcNode.content);
    } else if (srcNode.type === 'directory') {
      if (!options?.recursive) {
        throw new Error(`EISDIR: illegal operation on a directory, '${src}'`);
      }

      await this.mkdir(dest, { recursive: true });

      const srcPrefix = normalizedSrc === '/' ? '/' : normalizedSrc + '/';
      for (const [p, n] of nodes) {
        if (p.startsWith(srcPrefix)) {
          const relativePath = p.slice(srcPrefix.length);
          const destPath = normalizedDest + '/' + relativePath;
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
    const normalized = this.normalizePath(path);
    const node = nodes.get(normalized);
    if (!node) {
      throw new Error(`ENOENT: no such file or directory, '${path}'`);
    }
  }
}
