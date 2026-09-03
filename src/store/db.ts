import {
  Database,
  SQLiteError,
  type SQLQueryBindings,
} from "bun:sqlite";

import { AppError } from "../contracts/errors";
import type { JsonObject } from "../contracts/item";

// Translate SQLite failures at the store boundary. Unique and primary-key
// violations are conflicts, while other constraints retain a separate code.
export function translate(error: Error | string, context: JsonObject): AppError {
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
  const message = error instanceof Error ? error.message : String(error);
  return new AppError("STORE_WRITE_FAILED", message, context);
}

// Runs one write statement and returns the number of changed rows.
export function write(
  db: Database,
  sql: string,
  params: SQLQueryBindings[],
  context: JsonObject,
): number {
  try {
    return db.run(sql, params).changes;
  } catch (error) {
    if (error instanceof Error) throw translate(error, context);
    throw translate(String(error), context);
  }
}

export type Migration = { version: number; sql: string };

export type TableInfo = { name: string; sql: string; columns: string[] };

export const SCHEMA_VERSION = 2;

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
        -- A worker reserves the item ID before writing files. The item row
        -- doesn't exist until ingest commits, so this column can't use a
        -- foreign key.
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
  {
    version: 2,
    sql: `
      CREATE TABLE items_new (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        url         TEXT NOT NULL,
        title       TEXT NOT NULL,
        author      TEXT,
        created_at  TEXT NOT NULL,
        ingested_at TEXT
      );
      INSERT INTO items_new (id, user_id, url, title, author, created_at, ingested_at)
        SELECT id, user_id, url, title, author, created_at, ingested_at
        FROM items
        WHERE kind = 'article' AND url IS NOT NULL;

      DELETE FROM blocks_fts
        WHERE item_id NOT IN (SELECT id FROM items_new);
      DROP INDEX items_user_created;
      DROP INDEX items_user_url;
      ALTER TABLE items RENAME TO items_old;
      ALTER TABLE items_new RENAME TO items;

      CREATE TABLE annotations_new (
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
      INSERT INTO annotations_new (
        id, user_id, item_id, start_offset, end_offset, quote, note,
        created_at, updated_at
      )
        SELECT id, user_id, item_id, start_offset, end_offset, quote, note,
               created_at, updated_at
        FROM annotations
        WHERE item_id IN (SELECT id FROM items);
      DROP TABLE annotations;
      DROP TABLE items_old;
      ALTER TABLE annotations_new RENAME TO annotations;
      CREATE INDEX items_user_created ON items(user_id, created_at DESC, id DESC);
      CREATE UNIQUE INDEX items_user_url ON items(user_id, url);
      CREATE INDEX annotations_user_item_offset ON annotations(user_id, item_id, start_offset);

      CREATE TABLE fetch_requests_new (
        id               TEXT PRIMARY KEY,
        user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        item_id          TEXT,
        url              TEXT NOT NULL,
        state            TEXT NOT NULL CHECK (state IN ('queued', 'claimed', 'done', 'failed')),
        lease_expires_at TEXT,
        attempts         INTEGER NOT NULL DEFAULT 0,
        error_code       TEXT,
        created_at       TEXT NOT NULL
      );
      INSERT INTO fetch_requests_new (
        id, user_id, item_id, url, state, lease_expires_at, attempts,
        error_code, created_at
      )
        SELECT id, user_id, item_id, url, state, lease_expires_at, attempts,
               error_code, created_at
        FROM fetch_requests
        WHERE url IS NOT NULL;
      DROP TABLE fetch_requests;
      ALTER TABLE fetch_requests_new RENAME TO fetch_requests;
      CREATE INDEX fetch_requests_claimable ON fetch_requests(state, created_at, id);
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
        // No rollback is needed if the transaction didn't open or SQLite
        // already rolled it back.
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
