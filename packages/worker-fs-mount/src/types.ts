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
 * Stream-first filesystem interface that WorkerEntrypoints must implement.
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
