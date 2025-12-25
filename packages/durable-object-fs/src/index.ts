import { DurableObject } from 'cloudflare:workers';
import type { DirEntry, Stat, WorkerFilesystem } from 'worker-fs-mount';
import { createFsError, getBaseName, getParentPath, normalizePath, resolvePath } from 'worker-fs-mount/utils';
import { type DbEntry, initializeSchema } from './schema.js';

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

  // === Streaming Operations ===

  async createReadStream(
    path: string,
    options?: { start?: number; end?: number }
  ): Promise<ReadableStream<Uint8Array>> {
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

    const content = new Uint8Array(entry.content ?? new ArrayBuffer(0));
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
    this.ensureInitialized();

    const normalized = normalizePath(path);
    const parentPath = getParentPath(normalized);
    const self = this;
    let offset = options?.start ?? 0;

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

    if (existing?.type === 'directory') {
      throw createFsError('EISDIR', path);
    }

    // Handle different modes
    let existingContent: Uint8Array | null = null;
    let createdAt: number | null = null;
    let isFirstWrite = true;

    if (options?.flags === 'r+') {
      // Read-write mode: file must exist
      if (!existing || existing.type !== 'file') {
        throw createFsError('ENOENT', path);
      }
      existingContent = new Uint8Array(existing.content ?? new ArrayBuffer(0));
      createdAt = existing.created_at;
    } else if (options?.flags === 'a') {
      // Append mode: create if doesn't exist, set offset to end
      if (existing && existing.type === 'file') {
        existingContent = new Uint8Array(existing.content ?? new ArrayBuffer(0));
        offset = existingContent.length;
        createdAt = existing.created_at;
      }
    } else {
      // Write mode (default): create or truncate
      if (existing) {
        createdAt = existing.created_at;
      }
    }

    return new WritableStream({
      write(chunk) {
        let currentContent: Uint8Array;

        // In write mode, first write starts fresh (truncates existing)
        if (options?.flags !== 'r+' && options?.flags !== 'a' && isFirstWrite) {
          currentContent = new Uint8Array(0);
          isFirstWrite = false;
        } else {
          // Read current state from DB to handle multiple writes
          const currentResult = self.ctx.storage.sql
            .exec<Pick<DbEntry, 'content'>>(
              'SELECT content FROM entries WHERE path = ?',
              normalized
            )
            .toArray();

          if (currentResult[0]?.content) {
            currentContent = new Uint8Array(currentResult[0].content);
          } else if (existingContent) {
            currentContent = existingContent;
          } else {
            currentContent = new Uint8Array(0);
          }
        }

        const newLength = Math.max(currentContent.length, offset + chunk.length);
        const newContent = new Uint8Array(newLength);
        newContent.set(currentContent, 0);
        newContent.set(chunk, offset);

        const now = Date.now();

        const checkResult = self.ctx.storage.sql
          .exec<Pick<DbEntry, 'id'>>('SELECT id FROM entries WHERE path = ?', normalized)
          .toArray();

        if (checkResult.length > 0) {
          self.ctx.storage.sql.exec(
            'UPDATE entries SET content = ?, size = ?, modified_at = ? WHERE path = ?',
            newContent,
            newContent.length,
            now,
            normalized
          );
        } else {
          self.ctx.storage.sql.exec(
            `INSERT INTO entries (path, parent_path, name, type, size, content, created_at, modified_at)
             VALUES (?, ?, ?, 'file', ?, ?, ?, ?)`,
            normalized,
            parentPath,
            getBaseName(normalized),
            newContent.length,
            newContent,
            createdAt ?? now,
            now
          );
        }

        offset += chunk.length;
      },
      close() {
        // Handle case where stream is closed without any writes (e.g., truncate to zero)
        // In 'w' mode, if no writes occurred, we should create/truncate the file to empty
        if (isFirstWrite && options?.flags !== 'r+' && options?.flags !== 'a') {
          const now = Date.now();
          const emptyContent = new Uint8Array(0);

          const checkResult = self.ctx.storage.sql
            .exec<Pick<DbEntry, 'id'>>('SELECT id FROM entries WHERE path = ?', normalized)
            .toArray();

          if (checkResult.length > 0) {
            self.ctx.storage.sql.exec(
              'UPDATE entries SET content = ?, size = 0, modified_at = ? WHERE path = ?',
              emptyContent,
              now,
              normalized
            );
          } else {
            self.ctx.storage.sql.exec(
              `INSERT INTO entries (path, parent_path, name, type, size, content, created_at, modified_at)
               VALUES (?, ?, ?, 'file', 0, ?, ?, ?)`,
              normalized,
              parentPath,
              getBaseName(normalized),
              emptyContent,
              createdAt ?? now,
              now
            );
          }
        }
      },
    });
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
}
