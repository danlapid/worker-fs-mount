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
 * import { mount } from 'worker-fs-mount';
 * import { env } from 'cloudflare:workers';
 * import fs from 'node:fs/promises';
 *
 * // Mount at module level using importable env
 * const r2fs = new R2Filesystem(env.MY_BUCKET);
 * mount('/storage', r2fs);
 *
 * export default {
 *   async fetch(request: Request) {
 *     await fs.writeFile('/storage/hello.txt', 'Hello, World!');
 *     const content = await fs.readFile('/storage/hello.txt', 'utf8');
 *     return new Response(content);
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
      // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires bracket notation for index signatures
      type: (meta?.['type'] as R2FsMetadata['type']) ?? 'file',
      // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires bracket notation for index signatures
      created: meta?.['created'] ?? obj.uploaded.toISOString(),
      // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires bracket notation for index signatures
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

  // === Streaming Operations ===

  async createReadStream(
    path: string,
    options?: { start?: number; end?: number }
  ): Promise<ReadableStream<Uint8Array>> {
    const normalized = await this.resolveSymlinks(path);
    const key = pathToKey(normalized);

    const r2Options: R2GetOptions = {};
    if (options?.start !== undefined || options?.end !== undefined) {
      const start = options?.start ?? 0;
      const length = options?.end !== undefined ? options.end - start + 1 : undefined;
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
    const parentPath = getParentPath(normalized);

    // Verify parent directory exists
    if (parentPath !== '/') {
      const parentExists = await this.directoryExists(parentPath);
      if (!parentExists) {
        throw createFsError('ENOENT', parentPath);
      }
    }

    const key = pathToKey(normalized);

    // Check if trying to write to a directory
    const dirMarker = await this.bucket.head(key + DIR_MARKER);
    if (dirMarker) {
      throw createFsError('EISDIR', path);
    }

    const self = this;
    let offset = options?.start ?? 0;

    // Collect all chunks and write at once on close
    const chunks: Uint8Array[] = [];
    let existingContent: Uint8Array | null = null;
    let existingMeta: R2FsMetadata | null = null;

    // Get existing content if needed
    if (options?.flags === 'r+' || options?.flags === 'a') {
      const existing = await this.bucket.get(key);
      if (existing) {
        existingContent = new Uint8Array(await existing.arrayBuffer());
        existingMeta = this.parseMetadata(existing);
        if (options?.flags === 'a') {
          offset = existingContent.length;
        }
      } else if (options?.flags === 'r+') {
        throw createFsError('ENOENT', path);
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

        const now = new Date().toISOString();
        await self.bucket.put(key, finalContent, {
          customMetadata: {
            type: 'file',
            created: existingMeta?.created ?? now,
          },
        });
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
}
