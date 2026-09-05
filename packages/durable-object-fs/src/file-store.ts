import type { DurableObjectStorage, SqlStorage } from '@cloudflare/workers-types';
import type { Stat, SyncFileHandle, SyncOpenOptions } from 'worker-fs-mount';
import {
  createFsError,
  getBaseName,
  getParentPath,
  normalizePath,
  resolvePath,
} from 'worker-fs-mount/utils';
import { type DbEntry, initializeSchema } from './schema.js';

export const FILE_PAGE_SIZE = 64 * 1024;
export type StorageSource = SqlStorage | Pick<DurableObjectStorage, 'sql' | 'transactionSync'>;

type OpenFile = {
  id: number;
  refs: number;
  detached?: { stat: Stat; pages: Map<number, Uint8Array> };
};
const openFiles = new WeakMap<SqlStorage, Map<number, WeakRef<OpenFile>>>();

function offset(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw createFsError('EINVAL', String(value));
}

/** Shared file storage for the local and streaming filesystem APIs. */
export class FileStore {
  readonly sql: SqlStorage;
  private readonly storage: Exclude<StorageSource, SqlStorage> | undefined;
  private initialized = false;
  private readonly files: Map<number, WeakRef<OpenFile>>;

  constructor(source: StorageSource) {
    this.storage = 'sql' in source ? source : undefined;
    this.sql = this.storage?.sql ?? (source as SqlStorage);
    let files = openFiles.get(this.sql);
    if (!files) {
      files = new Map();
      openFiles.set(this.sql, files);
    }
    this.files = files;
  }

  initialize(): void {
    if (!this.initialized) {
      initializeSchema(this.sql);
      this.initialized = true;
    }
  }

  get transactional(): boolean {
    return this.storage !== undefined;
  }

  atomic<T>(fn: () => T): T {
    if (!this.storage) {
      throw Object.assign(
        new Error(
          'ENOSYS: pass DurableObjectStorage to LocalDOFilesystem for paged writes and writable descriptors'
        ),
        { code: 'ENOSYS' }
      );
    }
    this.initialize();
    return this.storage.transactionSync(fn);
  }

  resolve(path: string, follow = true): string {
    this.initialize();
    const parts = normalizePath(path).split('/').filter(Boolean);
    let resolved: string[] = [],
      links = 0;
    while (parts.length) {
      const part = parts.shift();
      if (!part || part === '.') continue;
      if (part === '..') {
        resolved.pop();
        continue;
      }
      const candidate = `/${[...resolved, part].join('/')}`;
      const entry = this.entry(candidate);
      if (entry?.type === 'symlink' && (follow || parts.length > 0)) {
        if (++links > 40) throw createFsError('ELOOP', path);
        const target = resolvePath(`/${resolved.join('/')}`, entry.symlink_target ?? '');
        parts.unshift(...target.split('/').filter(Boolean));
        resolved = [];
      } else {
        if (parts.length && !entry) throw createFsError('ENOENT', candidate);
        if (parts.length && entry?.type !== 'directory') throw createFsError('ENOTDIR', candidate);
        resolved.push(part);
      }
    }
    return `/${resolved.join('/')}`;
  }

  entry(path: string): DbEntry | undefined {
    this.initialize();
    return this.sql.exec<DbEntry>('SELECT * FROM entries WHERE path = ?', path).toArray()[0];
  }

  private byId(id: number): DbEntry | undefined {
    return this.sql.exec<DbEntry>('SELECT * FROM entries WHERE id = ?', id).toArray()[0];
  }

  stat(entry: DbEntry): Stat {
    const type =
      entry.type === 'directory' ? 0o040000 : entry.type === 'symlink' ? 0o120000 : 0o100000;
    return {
      type: entry.type,
      size: entry.size,
      ino: entry.id,
      nlink: 1,
      mode: type | (entry.mode ?? (entry.type === 'directory' ? 0o755 : 0o644)),
      created: new Date(entry.created_at),
      lastModified: new Date(entry.modified_at),
      writable: true,
    };
  }

  private readEntry(entry: DbEntry, buffer: Uint8Array, position: number): number {
    if (entry.type === 'directory') throw createFsError('EISDIR', entry.path);
    const length = Math.max(0, Math.min(buffer.byteLength, entry.size - position));
    buffer.fill(0, 0, length);
    if (!length) return 0;
    if (entry.content !== null) {
      buffer.set(new Uint8Array(entry.content).subarray(position, position + length));
      return length;
    }
    const first = Math.floor(position / FILE_PAGE_SIZE);
    const last = Math.floor((position + length - 1) / FILE_PAGE_SIZE);
    for (const page of this.sql.exec<{ page_index: number; content: ArrayBuffer }>(
      'SELECT page_index, content FROM file_pages WHERE entry_id = ? AND page_index BETWEEN ? AND ?',
      entry.id,
      first,
      last
    )) {
      const bytes = new Uint8Array(page.content);
      const start = page.page_index * FILE_PAGE_SIZE;
      const from = Math.max(position, start),
        end = Math.min(position + length, start + bytes.length);
      if (end > from) buffer.set(bytes.subarray(from - start, end - start), from - position);
    }
    return length;
  }

  readFile(path: string): Uint8Array {
    const entry = this.entry(this.resolve(path));
    if (!entry) throw createFsError('ENOENT', path);
    const result = new Uint8Array(entry.size);
    this.readEntry(entry, result, 0);
    return result;
  }

  private migrate(entry: DbEntry): void {
    if (entry.content === null) return;
    const bytes = new Uint8Array(entry.content);
    this.sql.exec('UPDATE entries SET content = NULL WHERE id = ?', entry.id);
    for (let offset = 0; offset < bytes.length; offset += FILE_PAGE_SIZE) {
      this.sql.exec(
        'INSERT OR REPLACE INTO file_pages VALUES (?, ?, ?)',
        entry.id,
        offset / FILE_PAGE_SIZE,
        bytes.slice(offset, offset + FILE_PAGE_SIZE)
      );
    }
  }

  private writeEntry(entry: DbEntry, bytes: Uint8Array, position: number): number {
    if (!bytes.length) return 0;
    this.migrate(entry);
    const size = Math.max(entry.size, position + bytes.length);
    for (let copied = 0; copied < bytes.length; ) {
      const offset = position + copied,
        index = Math.floor(offset / FILE_PAGE_SIZE);
      const within = offset % FILE_PAGE_SIZE,
        count = Math.min(bytes.length - copied, FILE_PAGE_SIZE - within);
      const old = this.sql
        .exec<{ content: ArrayBuffer }>(
          'SELECT content FROM file_pages WHERE entry_id = ? AND page_index = ?',
          entry.id,
          index
        )
        .toArray()[0];
      const data = new Uint8Array(Math.max(old?.content.byteLength ?? 0, within + count));
      if (old) data.set(new Uint8Array(old.content));
      data.set(bytes.subarray(copied, copied + count), within);
      this.sql.exec('INSERT OR REPLACE INTO file_pages VALUES (?, ?, ?)', entry.id, index, data);
      copied += count;
    }
    this.sql.exec(
      'UPDATE entries SET size = ?, modified_at = ? WHERE id = ?',
      size,
      Date.now(),
      entry.id
    );
    return bytes.length;
  }

  private truncateEntry(entry: DbEntry, length: number): void {
    this.migrate(entry);
    if (length < entry.size) {
      this.sql.exec(
        'DELETE FROM file_pages WHERE entry_id = ? AND page_index >= ?',
        entry.id,
        Math.ceil(length / FILE_PAGE_SIZE)
      );
      if (length % FILE_PAGE_SIZE) {
        this.sql.exec(
          'UPDATE file_pages SET content = substr(content, 1, ?) WHERE entry_id = ? AND page_index = ?',
          length % FILE_PAGE_SIZE,
          entry.id,
          Math.floor(length / FILE_PAGE_SIZE)
        );
      }
    }
    this.sql.exec(
      'UPDATE entries SET size = ?, modified_at = ? WHERE id = ?',
      length,
      Date.now(),
      entry.id
    );
  }

  open(path: string, options: SyncOpenOptions): SyncFileHandle {
    const original = this.resolve(path, false);
    let entry = this.entry(original);
    if (entry && options.create && options.exclusive) throw createFsError('EEXIST', path);
    if (entry?.type === 'symlink' && options.noFollow) throw createFsError('ELOOP', path);
    path = this.resolve(path);
    entry = this.entry(path);
    if (options.write || options.truncate || (!entry && options.create)) this.atomic(() => {});
    if (!entry) {
      if (!options.create) throw createFsError('ENOENT', path);
      const parent = this.entry(getParentPath(path));
      if (!parent) throw createFsError('ENOENT', getParentPath(path));
      if (parent.type !== 'directory') throw createFsError('ENOTDIR', getParentPath(path));
      if (options.directory) throw createFsError('ENOENT', path);
      this.atomic(() =>
        this.sql
          .exec(
            `INSERT INTO entries
        (path,parent_path,name,type,size,content,mode,created_at,modified_at) VALUES (?,?,?,'file',0,NULL,?,?,?)`,
            path,
            getParentPath(path),
            getBaseName(path),
            options.mode ?? 0o666,
            Date.now(),
            Date.now()
          )
          .toArray()
      );
      entry = this.entry(path);
    }
    if (!entry) throw createFsError('ENOENT', path);
    if (entry.type === 'directory' && options.write) throw createFsError('EISDIR', path);
    if (options.directory && entry.type !== 'directory') throw createFsError('ENOTDIR', path);
    if (entry.type === 'directory' && options.truncate) throw createFsError('EISDIR', path);
    if (options.truncate) this.atomic(() => this.truncateEntry(entry, 0));
    let group = this.files.get(entry.id)?.deref();
    if (!group) {
      group = { id: entry.id, refs: 0 };
      this.files.set(entry.id, new WeakRef(group));
    }
    group.refs++;
    let current: OpenFile | undefined = group;
    const opened = (): OpenFile => {
      if (!current) throw createFsError('EBADF', path);
      return current;
    };
    const linked = (): DbEntry | undefined => this.byId(opened().id);
    const unlinked = () => {
      const detached = opened().detached;
      if (!detached) throw createFsError('EBADF', path);
      return detached;
    };
    return {
      stat: () => {
        const entry = linked();
        return entry ? this.stat(entry) : { ...unlinked().stat };
      },
      read: (buffer, position) => {
        if (!options.read) throw createFsError('EBADF', path);
        offset(position);
        const entry = linked();
        if (entry) return this.readEntry(entry, buffer, position);
        const detached = unlinked();
        if (detached.stat.type === 'directory') throw createFsError('EISDIR', path);
        const count = Math.max(0, Math.min(buffer.length, detached.stat.size - position));
        buffer.fill(0, 0, count);
        for (let copied = 0; copied < count; ) {
          const index = Math.floor((position + copied) / FILE_PAGE_SIZE);
          const within = (position + copied) % FILE_PAGE_SIZE;
          const length = Math.min(count - copied, FILE_PAGE_SIZE - within);
          const page = detached.pages.get(index);
          if (page) buffer.set(page.subarray(within, within + length), copied);
          copied += length;
        }
        return count;
      },
      write: (buffer, position) => {
        if (!options.write) throw createFsError('EBADF', path);
        offset(position);
        return this.atomic(() => {
          const entry = linked();
          if (entry) {
            if (options.append) position = entry.size;
            offset(position + buffer.length);
            return this.writeEntry(entry, buffer, position);
          }
          const detached = unlinked();
          if (!buffer.length) return 0;
          if (options.append) position = detached.stat.size;
          offset(position + buffer.length);
          for (let copied = 0; copied < buffer.length; ) {
            const index = Math.floor((position + copied) / FILE_PAGE_SIZE);
            const within = (position + copied) % FILE_PAGE_SIZE;
            const count = Math.min(buffer.length - copied, FILE_PAGE_SIZE - within);
            const old = detached.pages.get(index);
            const page = new Uint8Array(Math.max(old?.length ?? 0, within + count));
            if (old) page.set(old);
            page.set(buffer.subarray(copied, copied + count), within);
            detached.pages.set(index, page);
            copied += count;
          }
          detached.stat = {
            ...detached.stat,
            size: Math.max(detached.stat.size, position + buffer.length),
            lastModified: new Date(),
          };
          return buffer.length;
        });
      },
      truncate: (length) => {
        offset(length);
        if (!options.write) throw createFsError('EBADF', path);
        this.atomic(() => {
          const entry = linked();
          if (entry) return this.truncateEntry(entry, length);
          const detached = unlinked();
          for (const [index, page] of detached.pages) {
            if (index * FILE_PAGE_SIZE >= length) detached.pages.delete(index);
            else if ((index + 1) * FILE_PAGE_SIZE > length) {
              detached.pages.set(index, page.slice(0, length % FILE_PAGE_SIZE));
            }
          }
          detached.stat = { ...detached.stat, size: length, lastModified: new Date() };
        });
      },
      chmod: (mode) =>
        this.atomic(() => {
          const entry = linked();
          if (entry)
            this.sql.exec('UPDATE entries SET mode = ? WHERE id = ?', mode & 0o7777, entry.id);
          else {
            const stat = unlinked().stat;
            stat.mode = ((stat.mode ?? 0) & 0o170000) | (mode & 0o7777);
          }
        }),
      sync: () => {
        opened();
      }, // SQL output gates cover writes; callers can also await storage.sync().
      close: () => {
        const file = opened();
        if (--file.refs === 0) this.files.delete(file.id);
        current = undefined;
      },
    };
  }

  writeFile(path: string, data: Uint8Array, flags: 'w' | 'a' | 'r+' = 'w'): void {
    this.atomic(() => {
      const file = this.open(path, {
        read: false,
        write: true,
        create: flags !== 'r+',
        truncate: flags === 'w',
        append: flags === 'a',
      });
      try {
        file.write(data, 0);
      } finally {
        file.close();
      }
    });
  }

  /** Retain unlinked bytes only while an open handle still references the inode. */
  prepareRemoval(entries: DbEntry[]): () => void {
    const detached = entries.flatMap((entry) => {
      const file = this.files.get(entry.id)?.deref();
      if (!file) {
        this.files.delete(entry.id);
        return [];
      }
      const pages = new Map<number, Uint8Array>();
      if (entry.content !== null) {
        const bytes = new Uint8Array(entry.content);
        for (let start = 0; start < bytes.length; start += FILE_PAGE_SIZE) {
          pages.set(start / FILE_PAGE_SIZE, bytes.slice(start, start + FILE_PAGE_SIZE));
        }
      } else {
        for (const row of this.sql.exec<{ page_index: number; content: ArrayBuffer }>(
          'SELECT page_index, content FROM file_pages WHERE entry_id = ?',
          entry.id
        )) {
          pages.set(row.page_index, new Uint8Array(row.content));
        }
      }
      return [{ file, pages, stat: { ...this.stat(entry), nlink: 0 } }];
    });
    return () => {
      for (const { file, pages, stat } of detached) file.detached = { pages, stat };
    };
  }

  rename(oldPath: string, newPath: string): void {
    oldPath = this.resolve(oldPath, false);
    newPath = this.resolve(newPath, false);
    if (oldPath === '/' || newPath === '/') throw createFsError('EBUSY', oldPath);
    if (oldPath === newPath) {
      if (!this.entry(oldPath)) throw createFsError('ENOENT', oldPath);
      return;
    }
    let finish = () => {};
    this.atomic(() => {
      const source = this.entry(oldPath),
        target = this.entry(newPath);
      if (!source) throw createFsError('ENOENT', oldPath);
      const parent = this.entry(getParentPath(newPath));
      if (!parent) throw createFsError('ENOENT', newPath);
      if (parent.type !== 'directory') throw createFsError('ENOTDIR', newPath);
      if (newPath.startsWith(`${oldPath}/`)) throw createFsError('EINVAL', newPath);
      if (target) {
        if (source.type === 'directory' && target.type !== 'directory')
          throw createFsError('ENOTDIR', newPath);
        if (source.type !== 'directory' && target.type === 'directory')
          throw createFsError('EISDIR', newPath);
        if (
          target.type === 'directory' &&
          this.sql.exec('SELECT id FROM entries WHERE parent_path = ? LIMIT 1', newPath).toArray()
            .length
        )
          throw createFsError('ENOTEMPTY', newPath);
        finish = this.prepareRemoval([target]);
        this.sql.exec('DELETE FROM entries WHERE id = ?', target.id);
      }
      this.sql.exec(
        `UPDATE entries SET
        path = ? || substr(path, length(?) + 1),
        parent_path = CASE WHEN id = ? THEN ? ELSE ? || substr(parent_path, length(?) + 1) END,
        name = CASE WHEN id = ? THEN ? ELSE name END
        WHERE path = ? OR substr(path, 1, length(?) + 1) = ? || '/'`,
        newPath,
        oldPath,
        source.id,
        getParentPath(newPath),
        newPath,
        oldPath,
        source.id,
        getBaseName(newPath),
        oldPath,
        oldPath,
        oldPath
      );
    });
    finish();
  }
}
