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

/** Default page size for new files, and the page size of files written before 1.1. */
export const FILE_PAGE_SIZE = 64 * 1024;
/** Largest accepted page size; Durable Object SQLite rows are limited to 2 MB. */
export const MAX_PAGE_SIZE = 1024 * 1024;
const MIN_PAGE_SIZE = 512;
const DEFAULT_DIRTY_LIMIT = 8 * 1024 * 1024;

export type StorageSource = SqlStorage | Pick<DurableObjectStorage, 'sql' | 'transactionSync'>;

/** Page reads and writes that reached SQLite. */
export interface PageIOEvent {
  op: 'read' | 'write';
  /** Path of the file, relative to the filesystem root. */
  path: string;
  /** Page rows read or written. */
  pages: number;
  /** Total size of those rows: a partial page write still rewrites the whole row. */
  bytes: number;
}

/** Cumulative counters for one filesystem instance. */
export interface FileStoreStats {
  /** Page rows read from SQLite (read cache hits excluded). */
  pagesRead: number;
  /** Page rows written to SQLite. */
  pagesWritten: number;
  /** Total size of the page rows read. */
  bytesRead: number;
  /** Total size of the page rows written. */
  bytesWritten: number;
  /** Bytes currently buffered by write-back, shared by all instances on the same storage. */
  dirtyBytes: number;
  /** Bytes currently held by the read cache, shared by all instances on the same storage. */
  cachedBytes: number;
}

export interface FileStoreOptions {
  /**
   * Page size for newly created files, in bytes, or a function choosing it per path.
   * Each file keeps the page size it was created with. Larger pages mean fewer rows
   * per read or write; a page that is written whole is replaced without reading it
   * first, so matching an application's block size avoids read-modify-write.
   * Default 64 KiB; at most 1 MiB.
   */
  pageSize?: number | ((path: string) => number);
  /**
   * Buffer writes in memory and write whole pages to SQLite on `fsync`, on `close`,
   * or once the buffered bytes exceed `dirtyLimit` (default 8 MiB). Many small writes
   * to a page between syncs cost one row write. Like an OS page cache, unsynced data
   * is lost if the Durable Object is evicted, and write errors surface at sync time.
   * Default off: every write goes straight to SQLite.
   */
  writeBack?: boolean | { dirtyLimit?: number };
  /**
   * Keep up to this many bytes of recently read or written pages in memory, so
   * repeated small reads of one page do not query SQLite again. Default 0 (off).
   */
  readCacheBytes?: number;
  /** Called whenever pages are read from or written to SQLite. */
  onPageIO?: (event: PageIOEvent) => void;
}

type Detached = { stat: Stat; pages: Map<number, Uint8Array>; pageSize: number };
type Inode = {
  id: number;
  refs: number;
  detached?: Detached;
  /** Buffered pages, each `pageSize` bytes long. Present only with pending changes. */
  dirty?: Map<number, Uint8Array>;
  pending?: { size: number; modified: number; pageSize: number };
};
/** In-memory state shared by every FileStore on the same SqlStorage. */
type Shared = {
  inodes: Map<number, WeakRef<Inode>>;
  /** Inodes with buffered writes, held strongly until flushed. */
  dirty: Set<Inode>;
  dirtyBytes: number;
  /** Clean pages keyed by `${inode}:${page}`, in least-recently-used order. */
  cache: Map<string, Uint8Array>;
  cacheBytes: number;
};
const sharedState = new WeakMap<SqlStorage, Shared>();

function offset(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw createFsError('EINVAL', String(value));
}

function validPageSize(size: number): number {
  if (!Number.isInteger(size) || size < MIN_PAGE_SIZE || size > MAX_PAGE_SIZE) {
    throw new RangeError(
      `durable-object-fs: page size must be an integer between ${MIN_PAGE_SIZE} and ${MAX_PAGE_SIZE}, got ${size}`
    );
  }
  return size;
}

const pageSizeOf = (entry: DbEntry): number => entry.page_size ?? FILE_PAGE_SIZE;
const key = (id: number, index: number) => `${id}:${index}`;

/** Shared file storage for the local and streaming filesystem APIs. */
export class FileStore {
  readonly sql: SqlStorage;
  private readonly storage: Exclude<StorageSource, SqlStorage> | undefined;
  private initialized = false;
  private readonly shared: Shared;
  private readonly pageSizeFor: (path: string) => number;
  private readonly writeBack: boolean;
  private readonly dirtyLimit: number;
  private readonly cacheLimit: number;
  private readonly onPageIO: ((event: PageIOEvent) => void) | undefined;
  private readonly counters = { pagesRead: 0, pagesWritten: 0, bytesRead: 0, bytesWritten: 0 };

  constructor(source: StorageSource, options: FileStoreOptions = {}) {
    this.storage = 'sql' in source ? source : undefined;
    this.sql = this.storage?.sql ?? (source as SqlStorage);
    let shared = sharedState.get(this.sql);
    if (!shared) {
      shared = {
        inodes: new Map(),
        dirty: new Set(),
        dirtyBytes: 0,
        cache: new Map(),
        cacheBytes: 0,
      };
      sharedState.set(this.sql, shared);
    }
    this.shared = shared;
    const { pageSize = FILE_PAGE_SIZE } = options;
    if (typeof pageSize === 'number') {
      validPageSize(pageSize);
      this.pageSizeFor = () => pageSize;
    } else {
      this.pageSizeFor = (path) => validPageSize(pageSize(path));
    }
    this.writeBack = !!options.writeBack;
    this.dirtyLimit =
      (typeof options.writeBack === 'object' ? options.writeBack.dirtyLimit : undefined) ??
      DEFAULT_DIRTY_LIMIT;
    this.cacheLimit = Math.max(0, options.readCacheBytes ?? 0);
    this.onPageIO = options.onPageIO;
    if (this.writeBack && !this.storage) {
      throw new TypeError(
        'durable-object-fs: writeBack requires DurableObjectStorage, not a bare SqlStorage'
      );
    }
  }

  initialize(): void {
    if (this.initialized) return;
    const fresh = !this.sql
      .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'entries'")
      .toArray().length;
    if (fresh) {
      // Storage was wiped (e.g. deleteAll()), so ids will be reused: forget pages
      // cached or buffered for the old files, and descriptors opened on them.
      this.discardCache();
      for (const inode of this.shared.dirty) {
        delete inode.dirty;
        delete inode.pending;
      }
      this.shared.dirty.clear();
      this.shared.dirtyBytes = 0;
      this.shared.inodes.clear();
    }
    initializeSchema(this.sql);
    this.initialized = true;
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
    try {
      return this.storage.transactionSync(fn);
    } catch (error) {
      // The rollback may have undone writes whose pages were already cached.
      this.discardCache();
      throw error;
    }
  }

  stats(): FileStoreStats {
    return {
      ...this.counters,
      dirtyBytes: this.shared.dirtyBytes,
      cachedBytes: this.shared.cacheBytes,
    };
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

  private inode(id: number): Inode | undefined {
    const inode = this.shared.inodes.get(id)?.deref();
    if (!inode) this.shared.inodes.delete(id);
    return inode;
  }

  stat(entry: DbEntry): Stat {
    const type =
      entry.type === 'directory' ? 0o040000 : entry.type === 'symlink' ? 0o120000 : 0o100000;
    const pending = this.inode(entry.id)?.pending;
    return {
      type: entry.type,
      size: pending?.size ?? entry.size,
      ino: entry.id,
      nlink: 1,
      mode: type | (entry.mode ?? (entry.type === 'directory' ? 0o755 : 0o644)),
      created: new Date(entry.created_at),
      lastModified: new Date(pending?.modified ?? entry.modified_at),
      writable: true,
    };
  }

  // === Page cache ===

  private cacheGet(id: number, index: number): Uint8Array | undefined {
    const k = key(id, index);
    const page = this.shared.cache.get(k);
    if (page) {
      this.shared.cache.delete(k); // Refresh recency.
      this.shared.cache.set(k, page);
    }
    return page;
  }

  private cachePut(id: number, index: number, page: Uint8Array): void {
    this.cacheDrop(key(id, index));
    if (!this.cacheLimit || page.byteLength > this.cacheLimit) return;
    const { cache } = this.shared;
    cache.set(key(id, index), page);
    this.shared.cacheBytes += page.byteLength;
    for (const [k, v] of cache) {
      if (this.shared.cacheBytes <= this.cacheLimit) break;
      cache.delete(k);
      this.shared.cacheBytes -= v.byteLength;
    }
  }

  private cacheDrop(k: string): void {
    const page = this.shared.cache.get(k);
    if (page) {
      this.shared.cache.delete(k);
      this.shared.cacheBytes -= page.byteLength;
    }
  }

  /** Drop cached pages of a file from `from` onwards. */
  invalidate(id: number, from = 0): void {
    if (!this.shared.cache.size) return;
    const prefix = `${id}:`;
    for (const k of [...this.shared.cache.keys()]) {
      if (k.startsWith(prefix) && Number(k.slice(prefix.length)) >= from) this.cacheDrop(k);
    }
  }

  private discardCache(): void {
    this.shared.cache.clear();
    this.shared.cacheBytes = 0;
  }

  // === Page I/O ===

  private report(op: 'read' | 'write', path: string, pages: number, bytes: number): void {
    if (!pages) return;
    if (op === 'read') {
      this.counters.pagesRead += pages;
      this.counters.bytesRead += bytes;
    } else {
      this.counters.pagesWritten += pages;
      this.counters.bytesWritten += bytes;
    }
    this.onPageIO?.({ op, path, pages, bytes });
  }

  /** Stored pages first..last of a file, adding them to the read cache. */
  private loadPages(entry: DbEntry, first: number, last: number): Map<number, Uint8Array> {
    const pages = new Map<number, Uint8Array>();
    let bytes = 0;
    for (const row of this.sql.exec<{ page_index: number; content: ArrayBuffer }>(
      'SELECT page_index, content FROM file_pages WHERE entry_id = ? AND page_index BETWEEN ? AND ?',
      entry.id,
      first,
      last
    )) {
      const page = new Uint8Array(row.content);
      pages.set(row.page_index, page);
      bytes += page.byteLength;
      this.cachePut(entry.id, row.page_index, page);
    }
    this.report('read', entry.path, pages.size, bytes);
    return pages;
  }

  private readEntry(entry: DbEntry, buffer: Uint8Array, position: number): number {
    if (entry.type === 'directory') throw createFsError('EISDIR', entry.path);
    const inode = this.inode(entry.id);
    const size = inode?.pending?.size ?? entry.size;
    const length = Math.max(0, Math.min(buffer.byteLength, size - position));
    buffer.fill(0, 0, length);
    if (!length) return 0;
    if (entry.content !== null) {
      buffer.set(new Uint8Array(entry.content).subarray(position, position + length));
      return length;
    }
    const pageSize = pageSizeOf(entry);
    const first = Math.floor(position / pageSize);
    const last = Math.floor((position + length - 1) / pageSize);
    const pages = new Map<number, Uint8Array>();
    let missingFirst = -1,
      missingLast = -1;
    for (let index = first; index <= last; index++) {
      const page = inode?.dirty?.get(index) ?? this.cacheGet(entry.id, index);
      if (page) pages.set(index, page);
      else {
        if (missingFirst < 0) missingFirst = index;
        missingLast = index;
      }
    }
    if (missingFirst >= 0) {
      for (const [index, page] of this.loadPages(entry, missingFirst, missingLast)) {
        if (!pages.has(index)) pages.set(index, page);
      }
    }
    for (const [index, page] of pages) {
      const start = index * pageSize;
      const from = Math.max(position, start),
        end = Math.min(position + length, start + page.byteLength);
      if (end > from) buffer.set(page.subarray(from - start, end - start), from - position);
    }
    return length;
  }

  readFile(path: string): Uint8Array {
    const entry = this.entry(this.resolve(path));
    if (!entry) throw createFsError('ENOENT', path);
    const result = new Uint8Array(this.inode(entry.id)?.pending?.size ?? entry.size);
    this.readEntry(entry, result, 0);
    return result;
  }

  /** Move inline (pre-paging) content into pages. */
  private migrate(entry: DbEntry): void {
    if (entry.content === null) return;
    const bytes = new Uint8Array(entry.content);
    const pageSize = pageSizeOf(entry);
    this.sql.exec('UPDATE entries SET content = NULL WHERE id = ?', entry.id);
    for (let start = 0; start < bytes.length; start += pageSize) {
      this.sql.exec(
        'INSERT OR REPLACE INTO file_pages VALUES (?, ?, ?)',
        entry.id,
        start / pageSize,
        bytes.slice(start, start + pageSize)
      );
    }
    entry.content = null;
  }

  private writeEntry(entry: DbEntry, bytes: Uint8Array, position: number): number {
    if (!bytes.length) return 0;
    this.migrate(entry);
    const inode = this.inode(entry.id);
    if (this.writeBack && inode) return this.bufferWrite(inode, entry, bytes, position);
    if (inode?.pending) {
      // Another instance on this storage buffered writes: apply them first.
      this.flushInode(inode);
      entry = this.byId(entry.id) ?? entry;
    }
    const pageSize = pageSizeOf(entry);
    const size = Math.max(entry.size, position + bytes.length);
    let pages = 0,
      written = 0;
    for (let copied = 0; copied < bytes.length; ) {
      const at = position + copied,
        index = Math.floor(at / pageSize);
      const within = at % pageSize,
        count = Math.min(bytes.length - copied, pageSize - within);
      // Bytes of this page that currently hold data.
      const live = Math.max(0, Math.min(pageSize, entry.size - index * pageSize));
      let data: Uint8Array;
      if (within === 0 && count >= live) {
        // The write covers everything stored in the page: no need to read it.
        data = bytes.slice(copied, copied + count);
      } else {
        const old =
          this.cacheGet(entry.id, index) ?? this.loadPages(entry, index, index).get(index);
        data = new Uint8Array(Math.max(old?.byteLength ?? 0, within + count));
        if (old) data.set(old);
        data.set(bytes.subarray(copied, copied + count), within);
      }
      this.sql.exec('INSERT OR REPLACE INTO file_pages VALUES (?, ?, ?)', entry.id, index, data);
      this.cachePut(entry.id, index, data);
      pages++;
      written += data.byteLength;
      copied += count;
    }
    this.report('write', entry.path, pages, written);
    this.sql.exec(
      'UPDATE entries SET size = ?, modified_at = ? WHERE id = ?',
      size,
      Date.now(),
      entry.id
    );
    return bytes.length;
  }

  private bufferWrite(inode: Inode, entry: DbEntry, bytes: Uint8Array, position: number): number {
    const pageSize = pageSizeOf(entry);
    inode.pending ??= { size: entry.size, modified: entry.modified_at, pageSize };
    inode.dirty ??= new Map();
    const { dirty, pending } = inode;
    for (let copied = 0; copied < bytes.length; ) {
      const at = position + copied,
        index = Math.floor(at / pageSize);
      const within = at % pageSize,
        count = Math.min(bytes.length - copied, pageSize - within);
      let page = dirty.get(index);
      if (!page) {
        page = new Uint8Array(pageSize);
        const live = Math.max(0, Math.min(pageSize, pending.size - index * pageSize));
        if (live && !(within === 0 && count >= live)) {
          const old =
            this.cacheGet(entry.id, index) ?? this.loadPages(entry, index, index).get(index);
          if (old) page.set(old.subarray(0, pageSize));
        }
        dirty.set(index, page);
        this.shared.dirtyBytes += pageSize;
      }
      page.set(bytes.subarray(copied, copied + count), within);
      copied += count;
    }
    pending.size = Math.max(pending.size, position + bytes.length);
    pending.modified = Date.now();
    this.shared.dirty.add(inode);
    if (this.shared.dirtyBytes > this.dirtyLimit) this.flush();
    return bytes.length;
  }

  /** Write an inode's buffered pages and metadata to SQLite. */
  private flushInode(inode: Inode): void {
    const { dirty, pending } = inode;
    if (!pending) return;
    let written: [number, Uint8Array][] = [];
    this.atomic(() => {
      const entry = this.sql
        .exec<Pick<DbEntry, 'path'>>('SELECT path FROM entries WHERE id = ?', inode.id)
        .toArray()[0];
      if (!entry) return; // Removed meanwhile: nothing to keep.
      let bytes = 0;
      written = [];
      for (const [index, page] of dirty ?? []) {
        const length = Math.min(pending.pageSize, pending.size - index * pending.pageSize);
        if (length <= 0) continue;
        const data = page.slice(0, length);
        this.sql.exec('INSERT OR REPLACE INTO file_pages VALUES (?, ?, ?)', inode.id, index, data);
        written.push([index, data]);
        bytes += length;
      }
      this.sql.exec(
        'UPDATE entries SET size = ?, modified_at = ? WHERE id = ?',
        pending.size,
        pending.modified,
        inode.id
      );
      this.report('write', entry.path, written.length, bytes);
    });
    for (const [index, data] of written) this.cachePut(inode.id, index, data);
    this.shared.dirtyBytes -= (dirty?.size ?? 0) * pending.pageSize;
    delete inode.dirty;
    delete inode.pending;
    this.shared.dirty.delete(inode);
  }

  /** Write every buffered page (from any instance on this storage) to SQLite. */
  flush(): void {
    // One transaction per file, so a failure keeps the unflushed files buffered.
    for (const inode of [...this.shared.dirty]) this.flushInode(inode);
  }

  private truncateEntry(entry: DbEntry, length: number): void {
    this.migrate(entry);
    const inode = this.inode(entry.id);
    if (inode?.pending) {
      this.flushInode(inode);
      entry = this.byId(entry.id) ?? entry;
    }
    const pageSize = pageSizeOf(entry);
    if (length < entry.size) {
      this.sql.exec(
        'DELETE FROM file_pages WHERE entry_id = ? AND page_index >= ?',
        entry.id,
        Math.ceil(length / pageSize)
      );
      if (length % pageSize) {
        this.sql.exec(
          'UPDATE file_pages SET content = substr(content, 1, ?) WHERE entry_id = ? AND page_index = ?',
          length % pageSize,
          entry.id,
          Math.floor(length / pageSize)
        );
      }
      this.invalidate(entry.id, Math.floor(length / pageSize));
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
      const pageSize = this.pageSizeFor(path);
      this.atomic(() =>
        this.sql
          .exec(
            `INSERT INTO entries
        (path,parent_path,name,type,size,content,mode,created_at,modified_at,page_size)
        VALUES (?,?,?,'file',0,NULL,?,?,?,?)`,
            path,
            getParentPath(path),
            getBaseName(path),
            options.mode ?? 0o666,
            Date.now(),
            Date.now(),
            pageSize
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
    let group = this.inode(entry.id);
    if (!group) {
      group = { id: entry.id, refs: 0 };
      this.shared.inodes.set(entry.id, new WeakRef(group));
    }
    group.refs++;
    let current: Inode | undefined = group;
    const opened = (): Inode => {
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
        const pageSize = detached.pageSize;
        const count = Math.max(0, Math.min(buffer.length, detached.stat.size - position));
        buffer.fill(0, 0, count);
        for (let copied = 0; copied < count; ) {
          const index = Math.floor((position + copied) / pageSize);
          const within = (position + copied) % pageSize;
          const length = Math.min(count - copied, pageSize - within);
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
            if (options.append) position = opened().pending?.size ?? entry.size;
            offset(position + buffer.length);
            return this.writeEntry(entry, buffer, position);
          }
          const detached = unlinked();
          if (!buffer.length) return 0;
          if (options.append) position = detached.stat.size;
          offset(position + buffer.length);
          const pageSize = detached.pageSize;
          for (let copied = 0; copied < buffer.length; ) {
            const index = Math.floor((position + copied) / pageSize);
            const within = (position + copied) % pageSize;
            const count = Math.min(buffer.length - copied, pageSize - within);
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
          const pageSize = detached.pageSize;
          for (const [index, page] of detached.pages) {
            if (index * pageSize >= length) detached.pages.delete(index);
            else if ((index + 1) * pageSize > length) {
              detached.pages.set(index, page.slice(0, length % pageSize));
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
      // Written pages are covered by SQL output gates; callers can also await storage.sync().
      sync: () => this.flushInode(opened()),
      close: () => {
        const file = opened();
        try {
          this.flushInode(file);
        } finally {
          if (--file.refs === 0 && !file.pending) this.shared.inodes.delete(file.id);
          current = undefined;
        }
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
      const file = this.inode(entry.id);
      if (!file) return [];
      if (file.pending) {
        this.flushInode(file);
        entry = this.byId(entry.id) ?? entry;
      }
      const pageSize = pageSizeOf(entry);
      const pages = new Map<number, Uint8Array>();
      if (entry.content !== null) {
        const bytes = new Uint8Array(entry.content);
        for (let start = 0; start < bytes.length; start += pageSize) {
          pages.set(start / pageSize, bytes.slice(start, start + pageSize));
        }
      } else {
        for (const row of this.sql.exec<{ page_index: number; content: ArrayBuffer }>(
          'SELECT page_index, content FROM file_pages WHERE entry_id = ?',
          entry.id
        )) {
          pages.set(row.page_index, new Uint8Array(row.content));
        }
      }
      return [{ file, pages, pageSize, stat: { ...this.stat(entry), nlink: 0 } }];
    });
    for (const entry of entries) this.invalidate(entry.id);
    return () => {
      for (const { file, pages, pageSize, stat } of detached) {
        file.detached = { pages, pageSize, stat };
      }
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
