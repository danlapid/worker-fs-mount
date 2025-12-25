import type { DirEntry, Stat, WorkerFilesystem } from 'worker-fs-mount';
import { createFsError, getParentPath, normalizePath, resolvePath } from 'worker-fs-mount/utils';

/**
 * Convert a filesystem path to an R2 key.
 * R2 keys don't have a leading slash.
 */
function pathToKey(path: string): string {
  const normalized = normalizePath(path);
  return normalized === '/' ? '' : normalized.slice(1);
}

/**
 * Metadata stored in R2 customMetadata for each object.
 */
interface R2FsMetadata {
  type: 'file' | 'directory' | 'symlink';
  created: string; // ISO timestamp
  symlinkTarget?: string | undefined;
}

/**
 * Suffix used to mark directory objects in R2.
 */
const DIR_MARKER = '.dir';

/**
 * An R2-backed filesystem implementation.
 * Can be used directly or extended in a WorkerEntrypoint.
 *
 * @example
 * ```typescript
 * import { R2Filesystem } from 'r2-fs';
 * import { mount, withMounts } from 'worker-fs-mount';
 * import { WorkerEntrypoint } from 'cloudflare:workers';
 * import fs from 'node:fs/promises';
 *
 * interface Env {
 *   MY_BUCKET: R2Bucket;
 * }
 *
 * // Option 1: Create an entrypoint that exposes the filesystem
 * export class MyFilesystem extends WorkerEntrypoint<Env> implements WorkerFilesystem {
 *   private fs = new R2Filesystem(this.env.MY_BUCKET);
 *
 *   stat = this.fs.stat.bind(this.fs);
 *   readFile = this.fs.readFile.bind(this.fs);
 *   writeFile = this.fs.writeFile.bind(this.fs);
 *   readdir = this.fs.readdir.bind(this.fs);
 *   mkdir = this.fs.mkdir.bind(this.fs);
 *   rm = this.fs.rm.bind(this.fs);
 *   unlink = this.fs.unlink.bind(this.fs);
 *   rename = this.fs.rename.bind(this.fs);
 *   cp = this.fs.cp.bind(this.fs);
 *   symlink = this.fs.symlink.bind(this.fs);
 *   readlink = this.fs.readlink.bind(this.fs);
 *   truncate = this.fs.truncate.bind(this.fs);
 *   access = this.fs.access.bind(this.fs);
 *   setLastModified = this.fs.setLastModified.bind(this.fs);
 *   read = this.fs.read.bind(this.fs);
 *   write = this.fs.write.bind(this.fs);
 *   createReadStream = this.fs.createReadStream.bind(this.fs);
 *   createWriteStream = this.fs.createWriteStream.bind(this.fs);
 * }
 *
 * // Option 2: Use directly in a fetch handler
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     return withMounts(async () => {
 *       const r2fs = new R2Filesystem(env.MY_BUCKET);
 *       mount('/storage', r2fs);
 *
 *       await fs.writeFile('/storage/hello.txt', 'Hello, World!');
 *       const content = await fs.readFile('/storage/hello.txt', 'utf8');
 *       return new Response(content);
 *     });
 *   }
 * }
 * ```
 */
export class R2Filesystem implements WorkerFilesystem {
  constructor(private bucket: R2Bucket) {}

  /**
   * Parse R2 object metadata into our internal format.
   */
  private parseMetadata(obj: R2Object): R2FsMetadata {
    const meta = obj.customMetadata;
    return {
      type: (meta?.['type'] as R2FsMetadata['type']) ?? 'file',
      created: meta?.['created'] ?? obj.uploaded.toISOString(),
      symlinkTarget: meta?.['symlinkTarget'],
    };
  }

  /**
   * Resolve symlinks in a path, following up to 40 levels deep.
   */
  private async resolveSymlinks(path: string, depth = 0): Promise<string> {
    if (depth > 40) {
      throw createFsError('ELOOP', path);
    }

    const normalized = normalizePath(path);
    if (normalized === '/') return normalized;

    const key = pathToKey(normalized);
    const obj = await this.bucket.head(key);

    if (!obj) return normalized;

    const meta = this.parseMetadata(obj);
    if (meta.type !== 'symlink' || !meta.symlinkTarget) {
      return normalized;
    }

    const target = resolvePath(getParentPath(normalized), meta.symlinkTarget);
    return this.resolveSymlinks(target, depth + 1);
  }

  /**
   * Check if a directory exists (either implicitly via prefix or explicitly via marker).
   */
  private async directoryExists(path: string): Promise<boolean> {
    if (path === '/') return true;

    const key = pathToKey(path);

    // Check for explicit directory marker
    const dirMarker = await this.bucket.head(key + DIR_MARKER);
    if (dirMarker) return true;

    // Check for any objects with this prefix (implicit directory)
    const prefix = `${key}/`;
    const listed = await this.bucket.list({ prefix, limit: 1 });
    return listed.objects.length > 0;
  }

  // === Metadata Operations ===

  async stat(path: string, options?: { followSymlinks?: boolean }): Promise<Stat | null> {
    let normalized = normalizePath(path);

    // Handle root directory
    if (normalized === '/') {
      return {
        type: 'directory',
        size: 0,
        writable: true,
      };
    }

    if (options?.followSymlinks !== false) {
      try {
        normalized = await this.resolveSymlinks(normalized);
      } catch {
        return null;
      }
    }

    const key = pathToKey(normalized);

    // First check if it's a file or symlink
    const obj = await this.bucket.head(key);
    if (obj) {
      const meta = this.parseMetadata(obj);
      return {
        type: meta.type,
        size: obj.size,
        created: new Date(meta.created),
        lastModified: obj.uploaded,
        writable: true,
      };
    }

    // Check if it's a directory
    const dirMarker = await this.bucket.head(key + DIR_MARKER);
    if (dirMarker) {
      const meta = this.parseMetadata(dirMarker);
      return {
        type: 'directory',
        size: 0,
        created: new Date(meta.created),
        lastModified: dirMarker.uploaded,
        writable: true,
      };
    }

    // Check for implicit directory (objects with this prefix)
    const prefix = `${key}/`;
    const listed = await this.bucket.list({ prefix, limit: 1 });
    if (listed.objects.length > 0) {
      return {
        type: 'directory',
        size: 0,
        writable: true,
      };
    }

    return null;
  }

  async setLastModified(path: string, _mtime: Date): Promise<void> {
    const normalized = normalizePath(path);
    const stat = await this.stat(normalized);

    if (!stat) {
      throw createFsError('ENOENT', path);
    }

    // R2 doesn't support updating metadata without re-uploading the object.
    // For now, we just verify the file exists. A full implementation would
    // need to read and re-write the object with new metadata.
  }

  // === File Operations (Whole File) ===

  async readFile(path: string): Promise<Uint8Array> {
    const normalized = await this.resolveSymlinks(path);
    const key = pathToKey(normalized);

    const obj = await this.bucket.get(key);
    if (!obj) {
      throw createFsError('ENOENT', path);
    }

    const meta = this.parseMetadata(obj);
    if (meta.type === 'directory') {
      throw createFsError('EISDIR', path);
    }

    return new Uint8Array(await obj.arrayBuffer());
  }

  async writeFile(
    path: string,
    data: Uint8Array,
    options?: { append?: boolean; exclusive?: boolean }
  ): Promise<number> {
    const normalized = normalizePath(path);
    const parentPath = getParentPath(normalized);

    // Verify parent directory exists
    if (parentPath !== '/') {
      const parentExists = await this.directoryExists(parentPath);
      if (!parentExists) {
        throw createFsError('ENOENT', parentPath);
      }
    }

    const key = pathToKey(normalized);

    // Check for exclusive flag
    if (options?.exclusive) {
      const existing = await this.bucket.head(key);
      if (existing) {
        throw createFsError('EEXIST', path);
      }
    }

    // Check if trying to write to a directory
    const dirMarker = await this.bucket.head(key + DIR_MARKER);
    if (dirMarker) {
      throw createFsError('EISDIR', path);
    }

    let finalData = data;

    // Handle append mode
    if (options?.append) {
      const existing = await this.bucket.get(key);
      if (existing) {
        const oldData = new Uint8Array(await existing.arrayBuffer());
        finalData = new Uint8Array(oldData.length + data.length);
        finalData.set(oldData, 0);
        finalData.set(data, oldData.length);
      }
    }

    const now = new Date().toISOString();
    const existingObj = await this.bucket.head(key);
    const created = existingObj ? this.parseMetadata(existingObj).created : now;

    await this.bucket.put(key, finalData, {
      customMetadata: {
        type: 'file',
        created,
      },
    });

    return data.length;
  }

  // === File Operations (Chunked) ===

  async read(path: string, options: { offset: number; length: number }): Promise<Uint8Array> {
    const normalized = await this.resolveSymlinks(path);
    const key = pathToKey(normalized);

    const obj = await this.bucket.get(key, {
      range: {
        offset: options.offset,
        length: options.length,
      },
    });

    if (!obj) {
      throw createFsError('ENOENT', path);
    }

    const meta = this.parseMetadata(obj);
    if (meta.type === 'directory') {
      throw createFsError('EISDIR', path);
    }

    return new Uint8Array(await obj.arrayBuffer());
  }

  async write(path: string, data: Uint8Array, options: { offset: number }): Promise<number> {
    const normalized = normalizePath(path);
    const key = pathToKey(normalized);

    // R2 doesn't support partial writes, so we need to read-modify-write
    const existing = await this.bucket.get(key);
    if (!existing) {
      throw createFsError('ENOENT', path);
    }

    const meta = this.parseMetadata(existing);
    if (meta.type !== 'file') {
      throw createFsError('EISDIR', path);
    }

    const oldContent = new Uint8Array(await existing.arrayBuffer());
    const newLength = Math.max(oldContent.length, options.offset + data.length);
    const newContent = new Uint8Array(newLength);
    newContent.set(oldContent, 0);
    newContent.set(data, options.offset);

    await this.bucket.put(key, newContent, {
      customMetadata: {
        type: 'file',
        created: meta.created,
      },
    });

    return data.length;
  }

  // === File Operations (Streaming) ===

  async createReadStream(
    path: string,
    options?: { start?: number; end?: number }
  ): Promise<ReadableStream<Uint8Array>> {
    const normalized = await this.resolveSymlinks(path);
    const key = pathToKey(normalized);

    const r2Options: R2GetOptions = {};
    if (options?.start !== undefined || options?.end !== undefined) {
      const start = options?.start ?? 0;
      const length = options?.end !== undefined ? options.end - start : undefined;
      r2Options.range = length !== undefined ? { offset: start, length } : { offset: start };
    }

    const obj = await this.bucket.get(key, r2Options);
    if (!obj) {
      throw createFsError('ENOENT', path);
    }

    const meta = this.parseMetadata(obj);
    if (meta.type === 'directory') {
      throw createFsError('EISDIR', path);
    }

    return obj.body;
  }

  async createWriteStream(
    path: string,
    options?: { start?: number; flags?: 'w' | 'a' | 'r+' }
  ): Promise<WritableStream<Uint8Array>> {
    const normalized = normalizePath(path);
    const key = pathToKey(normalized);
    const self = this;
    let offset = options?.start ?? 0;

    // Collect all chunks and write at once on close
    const chunks: Uint8Array[] = [];
    let existingContent: Uint8Array | null = null;

    // Get existing content if needed
    if (options?.flags === 'r+' || options?.flags === 'a') {
      const existing = await this.bucket.get(key);
      if (existing) {
        existingContent = new Uint8Array(await existing.arrayBuffer());
        if (options?.flags === 'a') {
          offset = existingContent.length;
        }
      }
    }

    return new WritableStream({
      write(chunk) {
        chunks.push(chunk);
      },
      async close() {
        // Combine all chunks
        const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
        const combinedChunks = new Uint8Array(totalLength);
        let pos = 0;
        for (const chunk of chunks) {
          combinedChunks.set(chunk, pos);
          pos += chunk.length;
        }

        // Build final content
        let finalContent: Uint8Array;
        if (existingContent && options?.flags !== 'w') {
          const newLength = Math.max(existingContent.length, offset + combinedChunks.length);
          finalContent = new Uint8Array(newLength);
          finalContent.set(existingContent, 0);
          finalContent.set(combinedChunks, offset);
        } else {
          finalContent = combinedChunks;
        }

        await self.bucket.put(key, finalContent, {
          customMetadata: {
            type: 'file',
            created: new Date().toISOString(),
          },
        });
      },
    });
  }

  // === Other File Operations ===

  async truncate(path: string, length = 0): Promise<void> {
    const normalized = normalizePath(path);
    const key = pathToKey(normalized);

    const existing = await this.bucket.get(key);
    if (!existing) {
      throw createFsError('ENOENT', path);
    }

    const meta = this.parseMetadata(existing);
    if (meta.type !== 'file') {
      throw createFsError('EISDIR', path);
    }

    const oldContent = new Uint8Array(await existing.arrayBuffer());
    let newContent: Uint8Array;

    if (length < oldContent.length) {
      newContent = oldContent.slice(0, length);
    } else if (length > oldContent.length) {
      newContent = new Uint8Array(length);
      newContent.set(oldContent, 0);
    } else {
      newContent = oldContent;
    }

    await this.bucket.put(key, newContent, {
      customMetadata: {
        type: 'file',
        created: meta.created,
      },
    });
  }

  // === Directory Operations ===

  async readdir(path: string, options?: { recursive?: boolean }): Promise<DirEntry[]> {
    const normalized = normalizePath(path);

    // Verify directory exists
    const stat = await this.stat(normalized);
    if (!stat) {
      throw createFsError('ENOENT', path);
    }
    if (stat.type !== 'directory') {
      throw createFsError('ENOTDIR', path);
    }

    const prefix = normalized === '/' ? '' : `${pathToKey(normalized)}/`;
    const entries: DirEntry[] = [];
    const seenDirs = new Set<string>();

    let cursor: string | undefined;

    do {
      const listOptions: R2ListOptions = { prefix };
      if (!options?.recursive) {
        listOptions.delimiter = '/';
      }
      if (cursor) {
        listOptions.cursor = cursor;
      }
      const listed = await this.bucket.list(listOptions);

      // Process objects
      for (const obj of listed.objects) {
        // Skip directory markers
        if (obj.key.endsWith(DIR_MARKER)) {
          // Extract directory name from marker
          const dirKey = obj.key.slice(0, -DIR_MARKER.length);
          const relativePath = prefix ? dirKey.slice(prefix.length) : dirKey;
          if (relativePath && !seenDirs.has(relativePath)) {
            seenDirs.add(relativePath);
            entries.push({
              name: relativePath,
              type: 'directory',
            });
          }
          continue;
        }

        const relativePath = prefix ? obj.key.slice(prefix.length) : obj.key;
        if (!relativePath) continue;

        const meta = this.parseMetadata(obj);
        entries.push({
          name: relativePath,
          type: meta.type,
        });
      }

      // Process common prefixes (implicit directories from delimiter)
      if (!options?.recursive && listed.delimitedPrefixes) {
        for (const dirPrefix of listed.delimitedPrefixes) {
          const dirName = dirPrefix.slice(prefix.length, -1); // Remove trailing /
          if (dirName && !seenDirs.has(dirName)) {
            seenDirs.add(dirName);
            entries.push({
              name: dirName,
              type: 'directory',
            });
          }
        }
      }

      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined> {
    const normalized = normalizePath(path);

    if (normalized === '/') {
      if (options?.recursive) return undefined;
      throw createFsError('EEXIST', path);
    }

    const key = pathToKey(normalized);

    // Check if already exists
    const existing = await this.stat(normalized);
    if (existing) {
      if (options?.recursive) return undefined;
      throw createFsError('EEXIST', path);
    }

    // Verify parent exists
    const parentPath = getParentPath(normalized);
    if (parentPath !== '/') {
      const parentExists = await this.directoryExists(parentPath);
      if (!parentExists) {
        if (options?.recursive) {
          await this.mkdir(parentPath, { recursive: true });
        } else {
          throw createFsError('ENOENT', parentPath);
        }
      }
    }

    // Create directory marker
    await this.bucket.put(key + DIR_MARKER, new Uint8Array(0), {
      customMetadata: {
        type: 'directory',
        created: new Date().toISOString(),
      },
    });

    return normalized;
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const normalized = normalizePath(path);

    if (normalized === '/') {
      throw createFsError('EINVAL', path);
    }

    const stat = await this.stat(normalized);
    if (!stat) {
      if (options?.force) return;
      throw createFsError('ENOENT', path);
    }

    const key = pathToKey(normalized);

    if (stat.type === 'directory') {
      const prefix = `${key}/`;

      // Check for children
      const listed = await this.bucket.list({ prefix, limit: 1 });
      if (listed.objects.length > 0) {
        if (!options?.recursive) {
          throw createFsError('ENOTEMPTY', path);
        }

        // Delete all children
        let cursor: string | undefined;
        do {
          const listOptions: R2ListOptions = { prefix, limit: 1000 };
          if (cursor) {
            listOptions.cursor = cursor;
          }
          const batch = await this.bucket.list(listOptions);
          if (batch.objects.length > 0) {
            await this.bucket.delete(batch.objects.map((o) => o.key));
          }
          cursor = batch.truncated ? batch.cursor : undefined;
        } while (cursor);
      }

      // Delete directory marker if it exists
      await this.bucket.delete(key + DIR_MARKER);
    } else {
      // Delete file or symlink
      await this.bucket.delete(key);
    }
  }

  // === Link Operations ===

  async symlink(linkPath: string, targetPath: string): Promise<void> {
    const normalizedLink = normalizePath(linkPath);
    const parentPath = getParentPath(normalizedLink);

    // Verify parent exists
    if (parentPath !== '/') {
      const parentExists = await this.directoryExists(parentPath);
      if (!parentExists) {
        throw createFsError('ENOENT', parentPath);
      }
    }

    // Check link doesn't exist
    const key = pathToKey(normalizedLink);
    const existing = await this.bucket.head(key);
    if (existing) {
      throw createFsError('EEXIST', linkPath);
    }

    // Check it's not a directory
    const dirMarker = await this.bucket.head(key + DIR_MARKER);
    if (dirMarker) {
      throw createFsError('EEXIST', linkPath);
    }

    await this.bucket.put(key, new Uint8Array(0), {
      customMetadata: {
        type: 'symlink',
        created: new Date().toISOString(),
        symlinkTarget: targetPath,
      },
    });
  }

  async readlink(path: string): Promise<string> {
    const normalized = normalizePath(path);
    const key = pathToKey(normalized);

    const obj = await this.bucket.head(key);
    if (!obj) {
      throw createFsError('ENOENT', path);
    }

    const meta = this.parseMetadata(obj);
    if (meta.type !== 'symlink' || !meta.symlinkTarget) {
      throw createFsError('EINVAL', path);
    }

    return meta.symlinkTarget;
  }

  async unlink(path: string): Promise<void> {
    const normalized = normalizePath(path);
    const key = pathToKey(normalized);

    // Check for directory marker first (directories throw EISDIR)
    const dirMarker = await this.bucket.head(key + DIR_MARKER);
    if (dirMarker) {
      throw createFsError('EISDIR', path);
    }

    const obj = await this.bucket.head(key);
    if (!obj) {
      throw createFsError('ENOENT', path);
    }

    const meta = this.parseMetadata(obj);
    if (meta.type === 'directory') {
      throw createFsError('EISDIR', path);
    }

    await this.bucket.delete(key);
  }

  // === Copy/Move Operations ===

  async rename(oldPath: string, newPath: string): Promise<void> {
    const normalizedOld = normalizePath(oldPath);
    const normalizedNew = normalizePath(newPath);

    // Get source info
    const srcStat = await this.stat(normalizedOld);
    if (!srcStat) {
      throw createFsError('ENOENT', oldPath);
    }

    // Verify destination parent exists
    const newParent = getParentPath(normalizedNew);
    if (newParent !== '/') {
      const parentExists = await this.directoryExists(newParent);
      if (!parentExists) {
        throw createFsError('ENOENT', newParent);
      }
    }

    const oldKey = pathToKey(normalizedOld);
    const newKey = pathToKey(normalizedNew);

    if (srcStat.type === 'directory') {
      // For directories, we need to copy all contents
      const oldPrefix = `${oldKey}/`;
      const newPrefix = `${newKey}/`;

      // Copy directory marker
      const oldDirMarker = await this.bucket.get(oldKey + DIR_MARKER);
      if (oldDirMarker) {
        const putOptions: R2PutOptions = {};
        if (oldDirMarker.customMetadata) {
          putOptions.customMetadata = oldDirMarker.customMetadata;
        }
        await this.bucket.put(newKey + DIR_MARKER, await oldDirMarker.arrayBuffer(), putOptions);
        await this.bucket.delete(oldKey + DIR_MARKER);
      } else {
        // Create new directory marker
        await this.bucket.put(newKey + DIR_MARKER, new Uint8Array(0), {
          customMetadata: {
            type: 'directory',
            created: new Date().toISOString(),
          },
        });
      }

      // Copy all children
      let cursor: string | undefined;
      do {
        const listOptions: R2ListOptions = { prefix: oldPrefix, limit: 1000 };
        if (cursor) {
          listOptions.cursor = cursor;
        }
        const listed = await this.bucket.list(listOptions);

        for (const obj of listed.objects) {
          const relativePath = obj.key.slice(oldPrefix.length);
          const newObjKey = newPrefix + relativePath;

          const fullObj = await this.bucket.get(obj.key);
          if (fullObj) {
            const putOptions: R2PutOptions = {};
            if (fullObj.customMetadata) {
              putOptions.customMetadata = fullObj.customMetadata;
            }
            await this.bucket.put(newObjKey, await fullObj.arrayBuffer(), putOptions);
          }
        }

        // Delete old objects
        if (listed.objects.length > 0) {
          await this.bucket.delete(listed.objects.map((o) => o.key));
        }

        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
    } else {
      // For files/symlinks, simple copy + delete
      const obj = await this.bucket.get(oldKey);
      if (obj) {
        const putOptions: R2PutOptions = {};
        if (obj.customMetadata) {
          putOptions.customMetadata = obj.customMetadata;
        }
        await this.bucket.put(newKey, await obj.arrayBuffer(), putOptions);
        await this.bucket.delete(oldKey);
      }
    }
  }

  async cp(src: string, dest: string, options?: { recursive?: boolean }): Promise<void> {
    const normalizedSrc = normalizePath(src);
    const normalizedDest = normalizePath(dest);

    const srcStat = await this.stat(normalizedSrc);
    if (!srcStat) {
      throw createFsError('ENOENT', src);
    }

    const srcKey = pathToKey(normalizedSrc);
    const destKey = pathToKey(normalizedDest);

    if (srcStat.type === 'file' || srcStat.type === 'symlink') {
      const obj = await this.bucket.get(srcKey);
      if (obj) {
        await this.bucket.put(destKey, await obj.arrayBuffer(), {
          customMetadata: {
            ...(obj.customMetadata ?? {}),
            created: new Date().toISOString(),
          },
        });
      }
    } else if (srcStat.type === 'directory') {
      if (!options?.recursive) {
        throw createFsError('EISDIR', src);
      }

      // Create destination directory
      await this.mkdir(normalizedDest, { recursive: true });

      const srcPrefix = `${srcKey}/`;
      const destPrefix = `${destKey}/`;

      let cursor: string | undefined;
      do {
        const listOptions: R2ListOptions = { prefix: srcPrefix, limit: 1000 };
        if (cursor) {
          listOptions.cursor = cursor;
        }
        const listed = await this.bucket.list(listOptions);

        for (const obj of listed.objects) {
          const relativePath = obj.key.slice(srcPrefix.length);
          const destObjKey = destPrefix + relativePath;

          const fullObj = await this.bucket.get(obj.key);
          if (fullObj) {
            await this.bucket.put(destObjKey, await fullObj.arrayBuffer(), {
              customMetadata: {
                ...(fullObj.customMetadata ?? {}),
                created: new Date().toISOString(),
              },
            });
          }
        }

        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
    }
  }

  async access(path: string, _mode?: number): Promise<void> {
    const stat = await this.stat(path);
    if (!stat) {
      throw createFsError('ENOENT', path);
    }
  }
}
