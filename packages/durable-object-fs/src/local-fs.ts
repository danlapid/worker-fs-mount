import type { SqlStorage } from '@cloudflare/workers-types';
import type { DirEntry, Stat, SyncWorkerFilesystem } from 'worker-fs-mount';
import { createFsError, getBaseName, getParentPath, normalizePath, resolvePath } from 'worker-fs-mount/utils';
import { type DbEntry, initializeSchema } from './schema.js';

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
 * import { mount } from 'worker-fs-mount';
 * import { LocalDOFilesystem } from 'durable-object-fs';
 * import fs from 'node:fs';
 *
 * export class MyDO extends DurableObject {
 *   constructor(ctx: DurableObjectState, env: Env) {
 *     super(ctx, env);
 *     const localFs = new LocalDOFilesystem(ctx.storage.sql);
 *     mount('/data', localFs);
 *   }
 *
 *   fetch(request: Request) {
 *     // Sync fs operations work!
 *     const config = fs.readFileSync('/data/config.json', 'utf8');
 *     fs.writeFileSync('/data/output.txt', 'processed');
 *     return new Response('OK');
 *   }
 * }
 * ```
 */
export class LocalDOFilesystem implements SyncWorkerFilesystem {
	private initialized = false;

	constructor(private readonly sql: SqlStorage) {}

	private ensureInitialized(): void {
		if (!this.initialized) {
			initializeSchema(this.sql);
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
		const result = this.sql
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

	statSync(path: string, options?: { followSymlinks?: boolean }): Stat | null {
		this.ensureInitialized();

		let normalized = normalizePath(path);

		if (options?.followSymlinks !== false) {
			try {
				normalized = this.resolveSymlinks(normalized);
			} catch {
				return null;
			}
		}

		const result = this.sql
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

	// === File Operations ===

	readFileSync(path: string): Uint8Array {
		this.ensureInitialized();

		const normalized = this.resolveSymlinks(path);
		const result = this.sql
			.exec<Pick<DbEntry, 'type' | 'content'>>('SELECT type, content FROM entries WHERE path = ?', normalized)
			.toArray();

		const entry = result[0];
		if (!entry) {
			throw createFsError('ENOENT', path);
		}
		if (entry.type === 'directory') {
			throw createFsError('EISDIR', path);
		}

		return new Uint8Array(entry.content ?? new ArrayBuffer(0));
	}

	writeFileSync(path: string, data: Uint8Array, options?: { flags?: 'w' | 'a' | 'r+' }): void {
		this.ensureInitialized();

		const normalized = normalizePath(path);
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
		let createdAt: number | null = existing?.created_at ?? null;

		if (options?.flags === 'r+') {
			// Read-write mode: file must exist
			if (!existing || existing.type !== 'file') {
				throw createFsError('ENOENT', path);
			}
			const existingContent = new Uint8Array(existing.content ?? new ArrayBuffer(0));
			finalContent = new Uint8Array(Math.max(existingContent.length, data.length));
			finalContent.set(existingContent, 0);
			finalContent.set(data, 0);
		} else if (options?.flags === 'a') {
			// Append mode: create if doesn't exist, append if exists
			if (existing?.type === 'file') {
				const existingContent = new Uint8Array(existing.content ?? new ArrayBuffer(0));
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
				.exec<Pick<DbEntry, 'name' | 'type'>>('SELECT name, type FROM entries WHERE parent_path = ?', normalized)
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

		const normalized = normalizePath(path);
		const result = this.sql
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
			const childrenResult = this.sql
				.exec<Pick<DbEntry, 'id'>>("SELECT id FROM entries WHERE path LIKE ? || '%' LIMIT 1", prefix)
				.toArray();

			if (childrenResult.length > 0) {
				if (!options?.recursive) {
					throw createFsError('ENOTEMPTY', path);
				}
				// Delete all descendants
				this.sql.exec("DELETE FROM entries WHERE path LIKE ? || '%'", prefix);
			}
		}

		this.sql.exec('DELETE FROM entries WHERE path = ?', normalized);
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
