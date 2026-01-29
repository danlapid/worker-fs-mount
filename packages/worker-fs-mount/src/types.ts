/**
 * Stat information for a file, directory, or symlink.
 */
export interface Stat {
  type: 'file' | 'directory' | 'symlink';
  size: number;
  lastModified?: Date;
  created?: Date;
  writable?: boolean;
}

/**
 * A directory entry returned by readdir.
 */
export interface DirEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink';
}

/**
 * Stream-first async filesystem interface that WorkerEntrypoints must implement.
 *
 * This is a minimal core interface - operations like readFile, writeFile,
 * truncate, cp, access, and rename are automatically derived from these
 * core streaming primitives by worker-fs-mount.
 */
export interface WorkerFilesystem {
  // === Metadata Operations ===

  /**
   * Get file/directory metadata.
   * @param path - Path relative to mount point
   * @param options - Options for the operation
   * @returns Stat object or null if not found
   */
  stat(path: string, options?: { followSymlinks?: boolean }): Promise<Stat | null>;

  // === Streaming Operations ===

  /**
   * Create a readable stream for a file.
   * @param path - Path relative to mount point
   * @param options - Stream options (start/end for partial reads)
   * @returns Promise resolving to ReadableStream that yields file chunks
   */
  createReadStream(
    path: string,
    options?: { start?: number; end?: number }
  ): Promise<ReadableStream<Uint8Array>>;

  /**
   * Create a writable stream for a file.
   * @param path - Path relative to mount point
   * @param options - Stream options (start for offset writes, flags for mode)
   * @returns Promise resolving to WritableStream
   */
  createWriteStream(
    path: string,
    options?: { start?: number; flags?: 'w' | 'a' | 'r+' }
  ): Promise<WritableStream<Uint8Array>>;

  // === Directory Operations ===

  /**
   * Read directory contents.
   * @param path - Path relative to mount point
   * @param options - Readdir options
   * @returns Array of directory entries
   */
  readdir(path: string, options?: { recursive?: boolean }): Promise<DirEntry[]>;

  /**
   * Create a directory.
   * @param path - Path relative to mount point
   * @param options - Mkdir options
   * @returns The path of the first created directory, or undefined
   */
  mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;

  /**
   * Remove a file or directory.
   * @param path - Path relative to mount point
   * @param options - Remove options
   */
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;

  // === Link Operations ===

  /**
   * Create a symbolic link.
   * @param linkPath - Path for the new symlink
   * @param targetPath - Path the symlink points to
   */
  symlink?(linkPath: string, targetPath: string): Promise<void>;

  /**
   * Read the target of a symbolic link.
   * @param path - Path relative to mount point
   * @returns The target path
   */
  readlink?(path: string): Promise<string>;
}

/**
 * Synchronous filesystem interface for local operations.
 *
 * Unlike WorkerFilesystem, these methods are synchronous and do not use streams.
 * This interface is suitable for filesystems that can perform I/O synchronously,
 * such as Durable Object SQLite storage (ctx.storage.sql).
 */
export interface SyncWorkerFilesystem {
  // === Metadata Operations ===

  /**
   * Get file/directory metadata synchronously.
   * @param path - Path relative to mount point
   * @param options - Options for the operation
   * @returns Stat object or null if not found
   */
  statSync(path: string, options?: { followSymlinks?: boolean }): Stat | null;

  // === File Operations ===

  /**
   * Read a file's contents synchronously.
   * @param path - Path relative to mount point
   * @returns The file contents as Uint8Array
   * @throws Error with code ENOENT if file not found
   * @throws Error with code EISDIR if path is a directory
   */
  readFileSync(path: string): Uint8Array;

  /**
   * Write data to a file synchronously.
   * @param path - Path relative to mount point
   * @param data - The data to write
   * @param options - Write options (flags for write mode)
   * @throws Error with code ENOENT if parent directory not found
   * @throws Error with code EISDIR if path is a directory
   */
  writeFileSync(path: string, data: Uint8Array, options?: { flags?: 'w' | 'a' | 'r+' }): void;

  // === Directory Operations ===

  /**
   * Read directory contents synchronously.
   * @param path - Path relative to mount point
   * @param options - Readdir options
   * @returns Array of directory entries
   * @throws Error with code ENOENT if directory not found
   * @throws Error with code ENOTDIR if path is not a directory
   */
  readdirSync(path: string, options?: { recursive?: boolean }): DirEntry[];

  /**
   * Create a directory synchronously.
   * @param path - Path relative to mount point
   * @param options - Mkdir options
   * @returns The path of the first created directory, or undefined
   * @throws Error with code EEXIST if path exists (unless recursive)
   * @throws Error with code ENOENT if parent not found (unless recursive)
   */
  mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;

  /**
   * Remove a file or directory synchronously.
   * @param path - Path relative to mount point
   * @param options - Remove options
   * @throws Error with code ENOENT if not found (unless force)
   * @throws Error with code ENOTEMPTY if directory not empty (unless recursive)
   */
  rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;

  // === Link Operations (Optional) ===

  /**
   * Create a symbolic link synchronously.
   * @param linkPath - Path for the new symlink
   * @param targetPath - Path the symlink points to
   * @throws Error with code EEXIST if link already exists
   * @throws Error with code ENOENT if parent directory not found
   */
  symlinkSync?(linkPath: string, targetPath: string): void;

  /**
   * Read the target of a symbolic link synchronously.
   * @param path - Path relative to mount point
   * @returns The target path
   * @throws Error with code ENOENT if symlink not found
   * @throws Error with code EINVAL if not a symlink
   */
  readlinkSync?(path: string): string;
}

/**
 * A mounted filesystem can implement either async, sync, or both interfaces.
 * The mount() function accepts any object that implements at least one of these.
 */
export type MountableFilesystem = WorkerFilesystem | SyncWorkerFilesystem | (WorkerFilesystem & SyncWorkerFilesystem);

/**
 * Type guard to check if a filesystem has async methods.
 */
export function hasAsyncMethods(fs: MountableFilesystem): fs is WorkerFilesystem {
  return typeof (fs as WorkerFilesystem).stat === 'function' &&
    typeof (fs as WorkerFilesystem).createReadStream === 'function' &&
    typeof (fs as WorkerFilesystem).createWriteStream === 'function';
}

/**
 * Type guard to check if a filesystem has sync methods.
 */
export function hasSyncMethods(fs: MountableFilesystem): fs is SyncWorkerFilesystem {
  return typeof (fs as SyncWorkerFilesystem).statSync === 'function' &&
    typeof (fs as SyncWorkerFilesystem).readFileSync === 'function' &&
    typeof (fs as SyncWorkerFilesystem).writeFileSync === 'function';
}
