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
  mode INTEGER,
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
  if (
    !sql
      .exec<{ name: string }>('PRAGMA table_info(entries)')
      .toArray()
      .some((c) => c.name === 'mode')
  ) {
    sql.exec('ALTER TABLE entries ADD COLUMN mode INTEGER');
  }
  sql.exec(`CREATE TABLE IF NOT EXISTS file_pages (
    entry_id INTEGER NOT NULL,
    page_index INTEGER NOT NULL,
    content BLOB NOT NULL,
    PRIMARY KEY (entry_id, page_index)
  )`);
  sql.exec(`CREATE TRIGGER IF NOT EXISTS delete_file_pages AFTER DELETE ON entries BEGIN
    DELETE FROM file_pages WHERE entry_id = OLD.id;
  END`);
  sql.exec(`CREATE TRIGGER IF NOT EXISTS inline_file_pages AFTER UPDATE OF content ON entries
    WHEN NEW.content IS NOT NULL BEGIN
      DELETE FROM file_pages WHERE entry_id = NEW.id;
    END`);

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
export type DbEntry = {
  id: number;
  path: string;
  parent_path: string;
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  content: ArrayBuffer | null;
  mode: number | null;
  symlink_target: string | null;
  created_at: number;
  modified_at: number;
};
