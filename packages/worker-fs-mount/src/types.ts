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
 * Interface that WorkerEntrypoints must implement to be mountable.
 * All methods are optional except the core ones.
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

  /**
   * Set the last modified time of a file.
   * @param path - Path relative to mount point
   * @param mtime - New modification time
   */
  setLastModified?(path: string, mtime: Date): Promise<void>;

  // === File Operations (Whole File) ===

  /**
   * Read entire file contents.
   * @param path - Path relative to mount point
   * @returns File contents as Uint8Array
   */
  readFile(path: string): Promise<Uint8Array>;

  /**
   * Write entire file contents.
   * @param path - Path relative to mount point
   * @param data - Data to write
   * @param options - Write options
   * @returns Number of bytes written
   */
  writeFile(
    path: string,
    data: Uint8Array,
    options?: { append?: boolean; exclusive?: boolean }
  ): Promise<number>;

  // === File Operations (Chunked) ===

  /**
   * Read a chunk of file contents at a specific offset.
   * @param path - Path relative to mount point
   * @param options - Read options with offset and length
   * @returns File chunk as Uint8Array
   */
  read?(path: string, options: { offset: number; length: number }): Promise<Uint8Array>;

  /**
   * Write data at a specific offset in the file.
   * @param path - Path relative to mount point
   * @param data - Data to write
   * @param options - Write options with offset
   * @returns Number of bytes written
   */
  write?(path: string, data: Uint8Array, options: { offset: number }): Promise<number>;

  // === File Operations (Streaming) ===

  /**
   * Create a readable stream for a file.
   * @param path - Path relative to mount point
   * @param options - Stream options
   * @returns ReadableStream that yields file chunks
   */
  createReadStream?(
    path: string,
    options?: { start?: number; end?: number }
  ): Promise<ReadableStream<Uint8Array>>;

  /**
   * Create a writable stream for a file.
   * @param path - Path relative to mount point
   * @param options - Stream options
   * @returns WritableStream to write file data
   */
  createWriteStream?(
    path: string,
    options?: { start?: number; flags?: 'w' | 'a' | 'r+' }
  ): Promise<WritableStream<Uint8Array>>;

  // === Other File Operations ===

  /**
   * Truncate a file to specified length.
   * @param path - Path relative to mount point
   * @param length - New length (default: 0)
   */
  truncate?(path: string, length?: number): Promise<void>;

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

  /**
   * Remove a file or symbolic link.
   * @param path - Path relative to mount point
   */
  unlink(path: string): Promise<void>;

  // === Copy/Move Operations ===

  /**
   * Rename (move) a file or directory.
   * @param oldPath - Current path
   * @param newPath - New path
   */
  rename?(oldPath: string, newPath: string): Promise<void>;

  /**
   * Copy a file or directory.
   * @param src - Source path
   * @param dest - Destination path
   * @param options - Copy options
   */
  cp?(src: string, dest: string, options?: { recursive?: boolean }): Promise<void>;

  /**
   * Check if a path exists and is accessible.
   * @param path - Path relative to mount point
   * @param mode - Access mode (not used, for Node.js compat)
   */
  access?(path: string, mode?: number): Promise<void>;
}

/**
 * Internal mount structure.
 */
export interface Mount {
  path: string;
  stub: WorkerFilesystem;
}

/**
 * Result of finding a mount for a path.
 */
export interface MountMatch {
  mount: Mount;
  relativePath: string;
}
