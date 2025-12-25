import { DurableObject } from 'cloudflare:workers';
import type { DirEntry, Stat, WorkerFilesystem } from 'worker-fs-mount';
import { createFsError } from './errors.js';
import { getBaseName, getParentPath, normalizePath, resolvePath } from './path-utils.js';
import { type DbEntry, initializeSchema } from './schema.js';

// Re-export types for convenience
export type { DirEntry, Stat, WorkerFilesystem } from 'worker-fs-mount';
export { createFsError } from './errors.js';
export { getBaseName, getParentPath, normalizePath } from './path-utils.js';

/**
 * A Durable Object that implements a filesystem using SQLite storage.
 * Can be mounted via worker-fs-mount to provide persistent filesystem storage.
 *
 * @example
 * ```typescript
 * // wrangler.toml
 * // [[migrations]]
 * // tag = "v1"
 * // new_sqlite_classes = ["DurableObjectFilesystem"]
 *
 * import { DurableObjectFilesystem } from 'durable-object-fs';
 * import { mount, withMounts } from 'worker-fs-mount';
 * import { WorkerEntrypoint } from 'cloudflare:workers';
 * import fs from 'node:fs/promises';
 *
 * export { DurableObjectFilesystem };
 *
 * export default class extends WorkerEntrypoint<Env> {
 *   async fetch(request: Request) {
 *     return withMounts(async () => {
 *       // Access DO via ctx.exports (run `wrangler types` for full typing)
 *       const id = this.ctx.exports.DurableObjectFilesystem.idFromName('user-123');
 *       const stub = this.ctx.exports.DurableObjectFilesystem.get(id);
 *
 *       mount('/data', stub);
 *
 *       await fs.writeFile('/data/hello.txt', 'Hello, World!');
 *       const content = await fs.readFile('/data/hello.txt', 'utf8');
 *
 *       return new Response(content);
 *     });
 *   }
 * }
 * ```
 */
export class DurableObjectFilesystem extends DurableObject implements WorkerFilesystem {
  private initialized = false;

  private ensureInitialized(): void {
    if (!this.initialized) {
      initializeSchema(this.ctx.storage.sql);
      this.initialized = true;
    }
  }

  /**
   * Resolve symlinks in a path, following up to 40 levels deep.
   * @param path - The path to resolve
   * @param depth - Current resolution depth (for loop detection)
   * @returns The resolved path
   * @throws Error with ELOOP if too many symlinks
   */
  private resolveSymlinks(path: string, depth = 0): string {
    if (depth > 40) {
      throw createFsError('ELOOP', path);
    }

    const normalized = normalizePath(path);
    const result = this.ctx.storage.sql
      .exec<Pick<DbEntry, 'type' | 'symlink_target'>>(
        'SELECT type, symlink_target FROM entries WHERE path = ?',
        normalized
      )
      .toArray();

    const entry = result[0];
    if (!entry || entry.type !== 'symlink' || !entry.symlink_target) {
      return normalized;
    }

    const target = resolvePath(getParentPath(normalized), entry.symlink_target);
    return this.resolveSymlinks(target, depth + 1);
  }

  // === Metadata Operations ===

  async stat(path: string, options?: { followSymlinks?: boolean }): Promise<Stat | null> {
    this.ensureInitialized();

    let normalized = normalizePath(path);

    if (options?.followSymlinks !== false) {
      try {
        normalized = this.resolveSymlinks(normalized);
      } catch {
        return null;
      }
    }

    const result = this.ctx.storage.sql
      .exec<Pick<DbEntry, 'type' | 'size' | 'created_at' | 'modified_at'>>(
        'SELECT type, size, created_at, modified_at FROM entries WHERE path = ?',
        normalized
      )
      .toArray();

    const entry = result[0];
    if (!entry) return null;

    return {
      type: entry.type,
      size: entry.size,
      created: new Date(entry.created_at),
      lastModified: new Date(entry.modified_at),
      writable: true,
    };
  }

  async setLastModified(path: string, mtime: Date): Promise<void> {
    this.ensureInitialized();

    const normalized = normalizePath(path);
    const result = this.ctx.storage.sql
      .exec<Pick<DbEntry, 'id'>>('SELECT id FROM entries WHERE path = ?', normalized)
      .toArray();

    if (result.length === 0) {
      throw createFsError('ENOENT', path);
    }

    this.ctx.storage.sql.exec(
      'UPDATE entries SET modified_at = ? WHERE path = ?',
      mtime.getTime(),
      normalized
    );
  }

  // === File Operations (Whole File) ===

  async readFile(path: string): Promise<Uint8Array> {
    this.ensureInitialized();

    const normalized = this.resolveSymlinks(path);
    const result = this.ctx.storage.sql
      .exec<Pick<DbEntry, 'type' | 'content'>>(
        'SELECT type, content FROM entries WHERE path = ?',
        normalized
      )
      .toArray();

    const entry = result[0];
    if (!entry) {
      throw createFsError('ENOENT', path);
    }
    if (entry.type === 'directory') {
      throw createFsError('EISDIR', path);
    }

    return new Uint8Array(entry.content ?? new ArrayBuffer(0));
  }

  async writeFile(
    path: string,
    data: Uint8Array,
    options?: { append?: boolean; exclusive?: boolean }
  ): Promise<number> {
    this.ensureInitialized();

    const normalized = normalizePath(path);
    const parentPath = getParentPath(normalized);

    // Verify parent exists and is a directory
    const parentResult = this.ctx.storage.sql
      .exec<Pick<DbEntry, 'type'>>('SELECT type FROM entries WHERE path = ?', parentPath)
      .toArray();

    const parent = parentResult[0];
    if (!parent) {
      throw createFsError('ENOENT', parentPath);
    }
    if (parent.type !== 'directory') {
      throw createFsError('ENOTDIR', parentPath);
    }

    // Check existing entry
    const existingResult = this.ctx.storage.sql
      .exec<Pick<DbEntry, 'type' | 'content' | 'created_at'>>(
        'SELECT type, content, created_at FROM entries WHERE path = ?',
        normalized
      )
      .toArray();

    const existing = existingResult[0];

    if (options?.exclusive && existing) {
      throw createFsError('EEXIST', path);
    }
    if (existing?.type === 'directory') {
      throw createFsError('EISDIR', path);
    }

    const now = Date.now();
    let finalContent: Uint8Array;

    if (options?.append && existing) {
      const oldContent = new Uint8Array(existing.content ?? new ArrayBuffer(0));
      finalContent = new Uint8Array(oldContent.length + data.length);
      finalContent.set(oldContent, 0);
      finalContent.set(data, oldContent.length);
    } else {
      finalContent = data;
    }

    if (existing) {
      this.ctx.storage.sql.exec(
        'UPDATE entries SET content = ?, size = ?, modified_at = ? WHERE path = ?',
        finalContent,
        finalContent.length,
        now,
        normalized
      );
    } else {
      this.ctx.storage.sql.exec(
        `INSERT INTO entries (path, parent_path, name, type, size, content, created_at, modified_at)
         VALUES (?, ?, ?, 'file', ?, ?, ?, ?)`,
        normalized,
        parentPath,
        getBaseName(normalized),
        finalContent.length,
        finalContent,
        now,
        now
      );
    }

    return data.length;
  }

  // === File Operations (Chunked) ===

  async read(path: string, options: { offset: number; length: number }): Promise<Uint8Array> {
    const content = await this.readFile(path);
    return content.slice(options.offset, options.offset + options.length);
  }

  async write(path: string, data: Uint8Array, options: { offset: number }): Promise<number> {
    this.ensureInitialized();

    const normalized = normalizePath(path);
    const result = this.ctx.storage.sql
      .exec<Pick<DbEntry, 'type' | 'content'>>(
        'SELECT type, content FROM entries WHERE path = ?',
        normalized
      )
      .toArray();

    const entry = result[0];
    if (!entry) {
      throw createFsError('ENOENT', path);
    }
    if (entry.type !== 'file') {
      throw createFsError('EISDIR', path);
    }

    const oldContent = new Uint8Array(entry.content ?? new ArrayBuffer(0));
    const newLength = Math.max(oldContent.length, options.offset + data.length);
    const newContent = new Uint8Array(newLength);
    newContent.set(oldContent, 0);
    newContent.set(data, options.offset);

    const now = Date.now();
    this.ctx.storage.sql.exec(
      'UPDATE entries SET content = ?, size = ?, modified_at = ? WHERE path = ?',
      newContent,
      newContent.length,
      now,
      normalized
    );

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
    this.ensureInitialized();

    const normalized = normalizePath(path);
    const self = this;
    let offset = options?.start ?? 0;

    // Initialize file if needed
    if (options?.flags !== 'r+') {
      const existingResult = this.ctx.storage.sql
        .exec<Pick<DbEntry, 'type' | 'content'>>(
          'SELECT type, content FROM entries WHERE path = ?',
          normalized
        )
        .toArray();

      const existing = existingResult[0];
      if (!existing || options?.flags === 'w') {
        await this.writeFile(path, new Uint8Array(0));
      }
      if (options?.flags === 'a' && existing?.type === 'file' && existing.content) {
        offset = existing.content.byteLength;
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
    this.ensureInitialized();

    const normalized = normalizePath(path);
    const result = this.ctx.storage.sql
      .exec<Pick<DbEntry, 'type' | 'content'>>(
        'SELECT type, content FROM entries WHERE path = ?',
        normalized
      )
      .toArray();

    const entry = result[0];
    if (!entry) {
      throw createFsError('ENOENT', path);
    }
    if (entry.type !== 'file') {
      throw createFsError('EISDIR', path);
    }

    const oldContent = new Uint8Array(entry.content ?? new ArrayBuffer(0));
    let newContent: Uint8Array;

    if (length < oldContent.length) {
      newContent = oldContent.slice(0, length);
    } else if (length > oldContent.length) {
      newContent = new Uint8Array(length);
      newContent.set(oldContent, 0);
    } else {
      newContent = oldContent;
    }

    const now = Date.now();
    this.ctx.storage.sql.exec(
      'UPDATE entries SET content = ?, size = ?, modified_at = ? WHERE path = ?',
      newContent,
      newContent.length,
      now,
      normalized
    );
  }

  // === Directory Operations ===

  async readdir(path: string, options?: { recursive?: boolean }): Promise<DirEntry[]> {
    this.ensureInitialized();

    const normalized = normalizePath(path);
    const result = this.ctx.storage.sql
      .exec<Pick<DbEntry, 'type'>>('SELECT type FROM entries WHERE path = ?', normalized)
      .toArray();

    const entry = result[0];
    if (!entry) {
      throw createFsError('ENOENT', path);
    }
    if (entry.type !== 'directory') {
      throw createFsError('ENOTDIR', path);
    }

    if (options?.recursive) {
      // Get all descendants
      const prefix = normalized === '/' ? '/' : `${normalized}/`;
      const children = this.ctx.storage.sql
        .exec<Pick<DbEntry, 'path' | 'type'>>(
          "SELECT path, type FROM entries WHERE path LIKE ? || '%' AND path != ?",
          prefix,
          normalized
        )
        .toArray();

      return children
        .map((child) => ({
          name: child.path.slice(prefix.length),
          type: child.type,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } else {
      // Get direct children only
      const children = this.ctx.storage.sql
        .exec<Pick<DbEntry, 'name' | 'type'>>(
          'SELECT name, type FROM entries WHERE parent_path = ?',
          normalized
        )
        .toArray();

      return children
        .map((child) => ({
          name: child.name,
          type: child.type,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined> {
    this.ensureInitialized();

    const normalized = normalizePath(path);

    const existingResult = this.ctx.storage.sql
      .exec<Pick<DbEntry, 'id'>>('SELECT id FROM entries WHERE path = ?', normalized)
      .toArray();

    if (existingResult.length > 0) {
      if (options?.recursive) return undefined;
      throw createFsError('EEXIST', path);
    }

    const parentPath = getParentPath(normalized);
    const parentResult = this.ctx.storage.sql
      .exec<Pick<DbEntry, 'type'>>('SELECT type FROM entries WHERE path = ?', parentPath)
      .toArray();

    const parent = parentResult[0];
    if (!parent) {
      if (options?.recursive) {
        await this.mkdir(parentPath, { recursive: true });
      } else {
        throw createFsError('ENOENT', parentPath);
      }
    } else if (parent.type !== 'directory') {
      throw createFsError('ENOTDIR', parentPath);
    }

    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO entries (path, parent_path, name, type, size, created_at, modified_at)
       VALUES (?, ?, ?, 'directory', 0, ?, ?)`,
      normalized,
      parentPath,
      getBaseName(normalized),
      now,
      now
    );

    return normalized;
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    this.ensureInitialized();

    const normalized = normalizePath(path);
    const result = this.ctx.storage.sql
      .exec<Pick<DbEntry, 'type'>>('SELECT type FROM entries WHERE path = ?', normalized)
      .toArray();

    const entry = result[0];
    if (!entry) {
      if (options?.force) return;
      throw createFsError('ENOENT', path);
    }

    if (entry.type === 'directory') {
      // Check for children
      const prefix = normalized === '/' ? '/' : `${normalized}/`;
      const childrenResult = this.ctx.storage.sql
        .exec<Pick<DbEntry, 'id'>>(
          "SELECT id FROM entries WHERE path LIKE ? || '%' LIMIT 1",
          prefix
        )
        .toArray();

      if (childrenResult.length > 0) {
        if (!options?.recursive) {
          throw createFsError('ENOTEMPTY', path);
        }
        // Delete all descendants
        this.ctx.storage.sql.exec("DELETE FROM entries WHERE path LIKE ? || '%'", prefix);
      }
    }

    this.ctx.storage.sql.exec('DELETE FROM entries WHERE path = ?', normalized);
  }

  // === Link Operations ===

  async symlink(linkPath: string, targetPath: string): Promise<void> {
    this.ensureInitialized();

    const normalizedLink = normalizePath(linkPath);
    const parentPath = getParentPath(normalizedLink);

    // Verify parent exists
    const parentResult = this.ctx.storage.sql
      .exec<Pick<DbEntry, 'type'>>('SELECT type FROM entries WHERE path = ?', parentPath)
      .toArray();

    const parent = parentResult[0];
    if (!parent) {
      throw createFsError('ENOENT', parentPath);
    }
    if (parent.type !== 'directory') {
      throw createFsError('ENOTDIR', parentPath);
    }

    // Check link doesn't exist
    const existingResult = this.ctx.storage.sql
      .exec<Pick<DbEntry, 'id'>>('SELECT id FROM entries WHERE path = ?', normalizedLink)
      .toArray();

    if (existingResult.length > 0) {
      throw createFsError('EEXIST', linkPath);
    }

    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO entries (path, parent_path, name, type, size, symlink_target, created_at, modified_at)
       VALUES (?, ?, ?, 'symlink', ?, ?, ?, ?)`,
      normalizedLink,
      parentPath,
      getBaseName(normalizedLink),
      targetPath.length,
      targetPath,
      now,
      now
    );
  }

  async readlink(path: string): Promise<string> {
    this.ensureInitialized();

    const normalized = normalizePath(path);
    const result = this.ctx.storage.sql
      .exec<Pick<DbEntry, 'type' | 'symlink_target'>>(
        'SELECT type, symlink_target FROM entries WHERE path = ?',
        normalized
      )
      .toArray();

    const entry = result[0];
    if (!entry) {
      throw createFsError('ENOENT', path);
    }
    if (entry.type !== 'symlink' || !entry.symlink_target) {
      throw createFsError('EINVAL', path);
    }

    return entry.symlink_target;
  }

  async unlink(path: string): Promise<void> {
    this.ensureInitialized();

    const normalized = normalizePath(path);
    const result = this.ctx.storage.sql
      .exec<Pick<DbEntry, 'type'>>('SELECT type FROM entries WHERE path = ?', normalized)
      .toArray();

    const entry = result[0];
    if (!entry) {
      throw createFsError('ENOENT', path);
    }
    if (entry.type === 'directory') {
      throw createFsError('EISDIR', path);
    }

    this.ctx.storage.sql.exec('DELETE FROM entries WHERE path = ?', normalized);
  }

  // === Copy/Move Operations ===

  async rename(oldPath: string, newPath: string): Promise<void> {
    this.ensureInitialized();

    const normalizedOld = normalizePath(oldPath);
    const normalizedNew = normalizePath(newPath);

    // Verify source exists
    const entryResult = this.ctx.storage.sql
      .exec<Pick<DbEntry, 'type'>>('SELECT type FROM entries WHERE path = ?', normalizedOld)
      .toArray();

    const entry = entryResult[0];
    if (!entry) {
      throw createFsError('ENOENT', oldPath);
    }

    // Verify destination parent exists
    const newParent = getParentPath(normalizedNew);
    const parentResult = this.ctx.storage.sql
      .exec<Pick<DbEntry, 'type'>>('SELECT type FROM entries WHERE path = ?', newParent)
      .toArray();

    const parent = parentResult[0];
    if (!parent) {
      throw createFsError('ENOENT', newParent);
    }
    if (parent.type !== 'directory') {
      throw createFsError('ENOTDIR', newParent);
    }

    const now = Date.now();

    // Delete any existing entry at destination
    this.ctx.storage.sql.exec('DELETE FROM entries WHERE path = ?', normalizedNew);

    // Update the entry itself
    this.ctx.storage.sql.exec(
      'UPDATE entries SET path = ?, parent_path = ?, name = ?, modified_at = ? WHERE path = ?',
      normalizedNew,
      newParent,
      getBaseName(normalizedNew),
      now,
      normalizedOld
    );

    // If directory, update all descendants
    if (entry.type === 'directory') {
      const oldPrefix = `${normalizedOld}/`;
      const newPrefix = `${normalizedNew}/`;

      // Get all descendants
      const descendants = this.ctx.storage.sql
        .exec<Pick<DbEntry, 'path'>>("SELECT path FROM entries WHERE path LIKE ? || '%'", oldPrefix)
        .toArray();

      for (const desc of descendants) {
        const newDescPath = newPrefix + desc.path.slice(oldPrefix.length);
        const newDescParent = getParentPath(newDescPath);
        this.ctx.storage.sql.exec(
          'UPDATE entries SET path = ?, parent_path = ? WHERE path = ?',
          newDescPath,
          newDescParent,
          desc.path
        );
      }
    }
  }

  async cp(src: string, dest: string, options?: { recursive?: boolean }): Promise<void> {
    this.ensureInitialized();

    const normalizedSrc = normalizePath(src);
    const normalizedDest = normalizePath(dest);

    const srcResult = this.ctx.storage.sql
      .exec<Pick<DbEntry, 'type' | 'content' | 'symlink_target'>>(
        'SELECT type, content, symlink_target FROM entries WHERE path = ?',
        normalizedSrc
      )
      .toArray();

    const srcEntry = srcResult[0];
    if (!srcEntry) {
      throw createFsError('ENOENT', src);
    }

    if (srcEntry.type === 'file') {
      await this.writeFile(dest, new Uint8Array(srcEntry.content ?? new ArrayBuffer(0)));
    } else if (srcEntry.type === 'directory') {
      if (!options?.recursive) {
        throw createFsError('EISDIR', src);
      }

      await this.mkdir(dest, { recursive: true });

      const srcPrefix = normalizedSrc === '/' ? '/' : `${normalizedSrc}/`;
      const descendants = this.ctx.storage.sql
        .exec<Pick<DbEntry, 'path' | 'type' | 'content' | 'symlink_target'>>(
          "SELECT path, type, content, symlink_target FROM entries WHERE path LIKE ? || '%'",
          srcPrefix
        )
        .toArray();

      for (const entry of descendants) {
        const relativePath = entry.path.slice(srcPrefix.length);
        const destPath = `${normalizedDest}/${relativePath}`;

        if (entry.type === 'file') {
          await this.writeFile(destPath, new Uint8Array(entry.content ?? new ArrayBuffer(0)));
        } else if (entry.type === 'directory') {
          await this.mkdir(destPath, { recursive: true });
        } else if (entry.type === 'symlink' && entry.symlink_target) {
          await this.symlink(destPath, entry.symlink_target);
        }
      }
    } else if (srcEntry.type === 'symlink' && srcEntry.symlink_target) {
      await this.symlink(dest, srcEntry.symlink_target);
    }
  }

  async access(path: string, _mode?: number): Promise<void> {
    this.ensureInitialized();

    const normalized = normalizePath(path);
    const result = this.ctx.storage.sql
      .exec<Pick<DbEntry, 'id'>>('SELECT id FROM entries WHERE path = ?', normalized)
      .toArray();

    if (result.length === 0) {
      throw createFsError('ENOENT', path);
    }
  }
}
