import { DurableObject } from 'cloudflare:workers';
import type { DirEntry, Stat, WorkerFilesystem } from 'worker-fs-mount';
import { createFsError, getBaseName, getParentPath, normalizePath } from 'worker-fs-mount/utils';
import { FILE_PAGE_SIZE, FileStore } from './file-store.js';
import { LocalDOFilesystem } from './local-fs.js';
import type { DbEntry } from './schema.js';

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
  private readonly files = new FileStore(this.ctx.storage);

  private ensureInitialized(): void {
    if (!this.initialized) {
      this.files.initialize();
      this.initialized = true;
    }
  }

  // === Metadata Operations ===

  async stat(path: string, options?: { followSymlinks?: boolean }): Promise<Stat | null> {
    this.ensureInitialized();

    let normalized: string;
    try {
      normalized = this.files.resolve(path, options?.followSymlinks !== false);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }

    const result = this.ctx.storage.sql
      .exec<DbEntry>('SELECT * FROM entries WHERE path = ?', normalized)
      .toArray();

    const entry = result[0];
    if (!entry) return null;

    return this.files.stat(entry);
  }

  // === Streaming Operations ===

  async createReadStream(
    path: string,
    options?: { start?: number; end?: number }
  ): Promise<ReadableStream<Uint8Array>> {
    const start = options?.start ?? 0;
    if (
      !Number.isSafeInteger(start) ||
      start < 0 ||
      (options?.end !== undefined && (!Number.isSafeInteger(options.end) || options.end < start))
    )
      throw createFsError('EINVAL', path);
    const file = this.files.open(path, { read: true, write: false });
    if (file.stat().type === 'directory') {
      file.close();
      throw createFsError('EISDIR', path);
    }
    const end = Math.min(file.stat().size, options?.end === undefined ? Infinity : options.end + 1);
    let position = start,
      closed = false;
    const close = () => {
      if (!closed) {
        closed = true;
        file.close();
      }
    };
    return new ReadableStream({
      pull(controller) {
        try {
          if (position >= end) {
            close();
            controller.close();
            return;
          }
          const buffer = new Uint8Array(Math.min(FILE_PAGE_SIZE, end - position));
          const count = file.read(buffer, position);
          if (!count) {
            close();
            controller.close();
            return;
          }
          position += count;
          controller.enqueue(buffer.subarray(0, count));
        } catch (error) {
          close();
          controller.error(error);
        }
      },
      cancel: close,
    });
  }

  async createWriteStream(
    path: string,
    options?: { start?: number; flags?: 'w' | 'a' | 'r+' }
  ): Promise<WritableStream<Uint8Array>> {
    let position = options?.start ?? 0;
    if (!Number.isSafeInteger(position) || position < 0) throw createFsError('EINVAL', path);
    const flags = options?.flags ?? 'w';
    const file = this.files.open(path, {
      read: false,
      write: true,
      create: flags !== 'r+',
      truncate: flags === 'w',
      append: flags === 'a',
    });
    let closed = false;
    const close = () => {
      if (!closed) {
        closed = true;
        file.close();
      }
    };
    return new WritableStream({
      write(chunk) {
        try {
          position += file.write(chunk, position);
        } catch (error) {
          close();
          throw error;
        }
      },
      close,
      abort: close,
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
    new LocalDOFilesystem(this.ctx.storage).rmSync(path, options);
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

// Re-export LocalDOFilesystem for sync operations
export { LocalDOFilesystem } from './local-fs.js';
