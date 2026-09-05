import type { SqlStorage } from '@cloudflare/workers-types';
import type {
  DirEntry,
  Stat,
  SyncFileHandle,
  SyncOpenOptions,
  SyncWorkerFilesystem,
} from 'worker-fs-mount';
import { createFsError, getBaseName, getParentPath, normalizePath } from 'worker-fs-mount/utils';
import { FileStore, type StorageSource } from './file-store.js';
import type { DbEntry } from './schema.js';

/**
 * Local synchronous filesystem for use within a Durable Object.
 * Uses ctx.storage.sql which is synchronous within DO context.
 *
 * This class is NOT a WorkerEntrypoint - it operates directly on SQLite storage
 * and is designed to be mounted using `mount()` for synchronous filesystem access.
 *
 * @example
 * ```typescript
 * import { DurableObject } from 'cloudflare:workers';
 * import { mount, withMounts } from 'worker-fs-mount';
 * import { LocalDOFilesystem } from 'durable-object-fs';
 * import fs from 'node:fs';
 *
 * export class MyDO extends DurableObject {
 *   private readonly filesystem = new LocalDOFilesystem(this.ctx.storage);
 *
 *   fetch(): Response {
 *     return withMounts(() => {
 *       mount('/data', this.filesystem);
 *       fs.writeFileSync('/data/output.txt', 'processed');
 *       return new Response('OK');
 *     });
 *   }
 * }
 * ```
 */
export class LocalDOFilesystem implements SyncWorkerFilesystem {
  private initialized = false;

  private readonly sql: SqlStorage;
  private readonly files: FileStore;

  constructor(storage: StorageSource) {
    this.files = new FileStore(storage);
    this.sql = this.files.sql;
    if (this.files.transactional) this.renameSync = (from, to) => this.files.rename(from, to);
  }

  openFileSync(path: string, options: SyncOpenOptions): SyncFileHandle {
    return this.files.open(path, options);
  }

  readonly renameSync?: (oldPath: string, newPath: string) => void;

  private ensureInitialized(): void {
    if (!this.initialized) {
      this.files.initialize();
      this.initialized = true;
    }
  }

  /**
   * Resolve symlinks in a path, following up to 40 levels deep.
   * @param path - The path to resolve
   * @returns The resolved path
   * @throws Error with ELOOP if too many symlinks
   */
  private resolveSymlinks(path: string): string {
    return this.files.resolve(path);
  }

  // === Metadata Operations ===

  statSync(path: string, options?: { followSymlinks?: boolean }): Stat | null {
    this.ensureInitialized();

    let normalized: string;
    try {
      normalized = this.files.resolve(path, options?.followSymlinks !== false);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }

    const result = this.sql
      .exec<DbEntry>('SELECT * FROM entries WHERE path = ?', normalized)
      .toArray();

    const entry = result[0];
    if (!entry) return null;

    return this.files.stat(entry);
  }

  // === File Operations ===

  readFileSync(path: string): Uint8Array {
    return this.files.readFile(path);
  }

  writeFileSync(path: string, data: Uint8Array, options?: { flags?: 'w' | 'a' | 'r+' }): void {
    if (this.files.transactional) {
      this.files.writeFile(path, data, options?.flags);
      return;
    }
    this.ensureInitialized();

    const normalized = this.resolveSymlinks(path);
    const parentPath = getParentPath(normalized);

    // Verify parent exists and is a directory
    const parentResult = this.sql
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
    const existingResult = this.sql
      .exec<Pick<DbEntry, 'type' | 'content' | 'created_at'>>(
        'SELECT type, content, created_at FROM entries WHERE path = ?',
        normalized
      )
      .toArray();

    const existing = existingResult[0];

    if (existing?.type === 'directory') {
      throw createFsError('EISDIR', path);
    }

    let finalContent: Uint8Array;
    const createdAt: number | null = existing?.created_at ?? null;

    if (options?.flags === 'r+') {
      // Read-write mode: file must exist
      if (!existing || existing.type !== 'file') {
        throw createFsError('ENOENT', path);
      }
      const existingContent = this.files.readFile(normalized);
      finalContent = new Uint8Array(Math.max(existingContent.length, data.length));
      finalContent.set(existingContent, 0);
      finalContent.set(data, 0);
    } else if (options?.flags === 'a') {
      // Append mode: create if doesn't exist, append if exists
      if (existing?.type === 'file') {
        const existingContent = this.files.readFile(normalized);
        finalContent = new Uint8Array(existingContent.length + data.length);
        finalContent.set(existingContent, 0);
        finalContent.set(data, existingContent.length);
      } else {
        finalContent = data;
      }
    } else {
      // Write mode (default): create or truncate
      finalContent = data;
    }

    if (finalContent.length >= 2 * 1024 * 1024) {
      throw Object.assign(
        new Error('ENOSYS: pass DurableObjectStorage to LocalDOFilesystem to write large files'),
        { code: 'ENOSYS' }
      );
    }
    const now = Date.now();

    if (existing) {
      this.sql.exec(
        'UPDATE entries SET content = ?, size = ?, modified_at = ? WHERE path = ?',
        finalContent,
        finalContent.length,
        now,
        normalized
      );
    } else {
      this.sql.exec(
        `INSERT INTO entries (path, parent_path, name, type, size, content, created_at, modified_at)
         VALUES (?, ?, ?, 'file', ?, ?, ?, ?)`,
        normalized,
        parentPath,
        getBaseName(normalized),
        finalContent.length,
        finalContent,
        createdAt ?? now,
        now
      );
    }
  }

  // === Directory Operations ===

  readdirSync(path: string, options?: { recursive?: boolean }): DirEntry[] {
    this.ensureInitialized();

    const normalized = normalizePath(path);
    const result = this.sql
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
      const children = this.sql
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
      const children = this.sql
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

  mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined {
    this.ensureInitialized();

    const normalized = normalizePath(path);

    const existingResult = this.sql
      .exec<Pick<DbEntry, 'id'>>('SELECT id FROM entries WHERE path = ?', normalized)
      .toArray();

    if (existingResult.length > 0) {
      if (options?.recursive) return undefined;
      throw createFsError('EEXIST', path);
    }

    const parentPath = getParentPath(normalized);
    const parentResult = this.sql
      .exec<Pick<DbEntry, 'type'>>('SELECT type FROM entries WHERE path = ?', parentPath)
      .toArray();

    const parent = parentResult[0];
    if (!parent) {
      if (options?.recursive) {
        this.mkdirSync(parentPath, { recursive: true });
      } else {
        throw createFsError('ENOENT', parentPath);
      }
    } else if (parent.type !== 'directory') {
      throw createFsError('ENOTDIR', parentPath);
    }

    const now = Date.now();
    this.sql.exec(
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

  rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void {
    this.ensureInitialized();
    let normalized: string;
    try {
      normalized = this.files.resolve(path, false);
    } catch (error) {
      if (options?.force && error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return;
      throw error;
    }
    if (normalized === '/') throw createFsError('EBUSY', path);
    let finish = () => {};
    const remove = () => {
      const entry = this.files.entry(normalized);
      if (!entry) {
        if (options?.force) return;
        throw createFsError('ENOENT', path);
      }
      const entries = this.sql
        .exec<DbEntry>(
          "SELECT * FROM entries WHERE path = ? OR substr(path, 1, length(?) + 1) = ? || '/'",
          normalized,
          normalized,
          normalized
        )
        .toArray();
      if (entry.type === 'directory' && entries.length > 1 && !options?.recursive)
        throw createFsError('ENOTEMPTY', path);
      finish = this.files.prepareRemoval(entries);
      this.sql.exec(
        "DELETE FROM entries WHERE path = ? OR substr(path, 1, length(?) + 1) = ? || '/'",
        normalized,
        normalized,
        normalized
      );
    };
    if (this.files.transactional) this.files.atomic(remove);
    else remove();
    finish();
  }

  // === Link Operations ===

  symlinkSync(linkPath: string, targetPath: string): void {
    this.ensureInitialized();

    const normalizedLink = normalizePath(linkPath);
    const parentPath = getParentPath(normalizedLink);

    // Verify parent exists
    const parentResult = this.sql
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
    const existingResult = this.sql
      .exec<Pick<DbEntry, 'id'>>('SELECT id FROM entries WHERE path = ?', normalizedLink)
      .toArray();

    if (existingResult.length > 0) {
      throw createFsError('EEXIST', linkPath);
    }

    const now = Date.now();
    this.sql.exec(
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

  readlinkSync(path: string): string {
    this.ensureInitialized();

    const normalized = normalizePath(path);
    const result = this.sql
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
