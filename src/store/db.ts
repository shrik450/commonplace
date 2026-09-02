import {
  Database,
  SQLiteError,
  type SQLQueryBindings,
} from "bun:sqlite";

import { AppError } from "../contracts/errors";

// A UNIQUE violation of any kind, including a duplicate primary key, is a
// conflict. Every other constraint failure keeps its own code, and any other
// driver failure, such as a missing table or a readonly file, is a failed
// write. Nothing raw leaves L2.
export function translate(
  error: unknown,
  context: Record<string, unknown>,
): AppError {
  if (error instanceof SQLiteError) {
    const code = error.code ?? "";
    if (code.includes("CONSTRAINT_UNIQUE") || code.includes("CONSTRAINT_PRIMARYKEY")) {
      return new AppError("STORE_CONFLICT", error.message, context);
    }
    if (code.includes("CONSTRAINT")) {
      return new AppError("STORE_CONSTRAINT_FAILED", error.message, context);
    }
    if (code.startsWith("SQLITE_BUSY")) {
      return new AppError("STORE_BUSY", error.message, context);
    }
    return new AppError("STORE_WRITE_FAILED", error.message, context);
  }
  return new AppError("STORE_WRITE_FAILED", String(error), context);
}

// Runs one write statement and translates any failure. Returns rows changed.
export function write(
  db: Database,
  sql: string,
  params: SQLQueryBindings[],
  context: Record<string, unknown>,
): number {
  try {
    return db.run(sql, params).changes;
  } catch (error) {
    throw translate(error, context);
  }
}

export type Migration = { version: number; sql: string };

export type TableInfo = { name: string; sql: string; columns: string[] };

export const SCHEMA_VERSION = 1;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE migrations (
        version    INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE users (
        id         TEXT PRIMARY KEY,
        subject    TEXT NOT NULL UNIQUE,
        email      TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE api_tokens (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name         TEXT NOT NULL,
        token_hash   TEXT NOT NULL UNIQUE,
        created_at   TEXT NOT NULL,
        last_used_at TEXT
      );
      CREATE INDEX api_tokens_user ON api_tokens(user_id);

      CREATE TABLE items (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind        TEXT NOT NULL CHECK (kind IN ('article', 'book')),
        url         TEXT,
        title       TEXT NOT NULL,
        author      TEXT,
        created_at  TEXT NOT NULL,
        ingested_at TEXT
      );
      CREATE INDEX items_user_created ON items(user_id, created_at DESC, id DESC);
      CREATE UNIQUE INDEX items_user_url ON items(user_id, url) WHERE url IS NOT NULL;

      CREATE TABLE annotations (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        item_id      TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        start_offset INTEGER NOT NULL,
        end_offset   INTEGER NOT NULL,
        quote        TEXT NOT NULL,
        note         TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        CHECK (end_offset >= start_offset),
        CHECK (start_offset >= 0)
      );
      CREATE INDEX annotations_user_item_offset ON annotations(user_id, item_id, start_offset);

      CREATE TABLE fetch_requests (
        id               TEXT PRIMARY KEY,
        user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        -- No foreign key. A worker reserves the item id here before it
        -- writes any file, and the item row does not exist until the ingest
        -- commits. That forward reference is the crash-safe order, and a
        -- foreign key cannot express "this will point at a row soon".
        item_id          TEXT,
        url              TEXT,
        source_path      TEXT,
        state            TEXT NOT NULL CHECK (state IN ('queued', 'claimed', 'done', 'failed')),
        lease_expires_at TEXT,
        attempts         INTEGER NOT NULL DEFAULT 0,
        error_code       TEXT,
        created_at       TEXT NOT NULL
      );
      CREATE INDEX fetch_requests_claimable ON fetch_requests(state, created_at, id);

      CREATE VIRTUAL TABLE blocks_fts USING fts5(
        text,
        item_id UNINDEXED,
        user_id UNINDEXED,
        block_index UNINDEXED,
        start_offset UNINDEXED,
        end_offset UNINDEXED,
        is_content UNINDEXED,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `,
  },
];

function appliedVersions(db: Database): Set<number> {
  const exists = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migrations'",
    )
    .get();
  if (exists === null || exists === undefined) return new Set();
  return new Set(
    db
      .query<{ version: number }, []>("SELECT version FROM migrations")
      .all()
      .map((row) => row.version),
  );
}

export function migrate(db: Database, now: Date): number {
  const applied = appliedVersions(db);
  let count = 0;
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    try {
      db.exec("BEGIN");
      db.exec(migration.sql);
      db.run(
        "INSERT INTO migrations (version, applied_at) VALUES (?, ?)",
        [migration.version, now.toISOString()],
      );
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The transaction was never open or already rolled back.
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new AppError("STORE_MIGRATION_FAILED", `migration ${migration.version} failed`, {
        version: migration.version,
        reason,
      });
    }
    count++;
  }
  return count;
}

export function openDatabase(path: string, now: Date): Database {
  let db: Database;
  try {
    db = new Database(path);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new AppError("STORE_OPEN_FAILED", `cannot open the database at ${path}`, {
      path,
      reason,
    });
  }
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");
  migrate(db, now);
  return db;
}

export function tableInfo(db: Database): TableInfo[] {
  const rows = db
    .query<{ name: string; sql: string }, []>(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table'",
    )
    .all();
  return rows.map((row) => ({
    name: row.name,
    sql: row.sql,
    columns: db
      .query<{ name: string }, []>(`PRAGMA table_info("${row.name.replaceAll('"', '""')}")`)
      .all()
      .map((column) => column.name),
  }));
}
