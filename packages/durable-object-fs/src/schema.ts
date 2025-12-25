import type { SqlStorage } from '@cloudflare/workers-types';

/**
 * SQL schema for the filesystem entries table.
 */
export const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  parent_path TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('file', 'directory', 'symlink')),
  size INTEGER NOT NULL DEFAULT 0,
  content BLOB,
  symlink_target TEXT,
  created_at INTEGER NOT NULL,
  modified_at INTEGER NOT NULL
)
`;

/**
 * Index for efficient directory listing queries.
 */
export const CREATE_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_parent_path ON entries(parent_path)
`;

/**
 * Initialize the filesystem schema in the SQLite database.
 * Creates the entries table and indexes if they don't exist.
 * Ensures the root directory exists.
 * @param sql - The SqlStorage instance from the Durable Object
 */
export function initializeSchema(sql: SqlStorage): void {
  sql.exec(CREATE_TABLE_SQL);
  sql.exec(CREATE_INDEX_SQL);

  // Ensure root directory exists
  const now = Date.now();
  sql.exec(
    `INSERT OR IGNORE INTO entries (path, parent_path, name, type, size, created_at, modified_at)
     VALUES ('/', '', '', 'directory', 0, ?, ?)`,
    now,
    now
  );
}

/**
 * Entry type stored in the database.
 */
export interface DbEntry {
  id: number;
  path: string;
  parent_path: string;
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  content: ArrayBuffer | null;
  symlink_target: string | null;
  created_at: number;
  modified_at: number;
}
