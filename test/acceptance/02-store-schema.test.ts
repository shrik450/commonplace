import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MIGRATIONS, SCHEMA_VERSION, openDatabase } from "../../src/store/db";

const APPLIED_AT = new Date("2026-02-01T00:00:00.000Z");
const roots: string[] = [];

describe("database migration behavior", () => {
  test("creates the current schema on a new database", async () => {
    const root = await mkdtemp(join(tmpdir(), "commonplace-schema-"));
    roots.push(root);
    const db = openDatabase(join(root, "db.sqlite"), APPLIED_AT);

    expect(SCHEMA_VERSION).toBe(3);
    expect(
      db.query<{ version: number }, []>(
        "SELECT version FROM migrations ORDER BY version",
      ).all(),
    ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    expect(
      db.query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'items'",
      ).get(),
    ).toEqual({ name: "items" });
    db.close();
  });

  test("migrates legacy article data and drops unsupported rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "commonplace-legacy-"));
    roots.push(root);
    const legacy = new Database(join(root, "db.sqlite"));
    legacy.exec(MIGRATIONS[0]!.sql);
    legacy.run(
      "INSERT INTO migrations (version, applied_at) VALUES (1, ?)",
      [APPLIED_AT.toISOString()],
    );
    legacy.run(
      "INSERT INTO users (id, subject, email, created_at) VALUES ('u', 'alice', NULL, 'created')",
    );
    legacy.run(
      "INSERT INTO items (id, user_id, kind, url, title, author, created_at, ingested_at) VALUES ('article', 'u', 'article', 'https://example.com/article', 'Article', NULL, 'created', NULL), ('book', 'u', 'book', NULL, 'Book', NULL, 'created', NULL), ('incomplete', 'u', 'article', NULL, 'Incomplete', NULL, 'created', NULL)",
    );
    legacy.run(
      "INSERT INTO annotations (id, user_id, item_id, start_offset, end_offset, quote, note, created_at, updated_at) VALUES ('keep', 'u', 'article', 0, 3, 'one', NULL, 'created', 'created'), ('drop-book', 'u', 'book', 0, 3, 'two', NULL, 'created', 'created')",
    );
    legacy.run(
      "INSERT INTO blocks_fts (text, item_id, user_id, block_index, start_offset, end_offset, is_content) VALUES ('one', 'article', 'u', 0, 0, 3, 1), ('two', 'book', 'u', 0, 0, 3, 1)",
    );
    legacy.run(
      "INSERT INTO fetch_requests (id, user_id, item_id, url, source_path, state, lease_expires_at, attempts, error_code, created_at) VALUES ('web-request', 'u', NULL, 'https://example.com/next', NULL, 'queued', NULL, 0, NULL, 'created'), ('book-request', 'u', NULL, NULL, '/books/book.epub', 'failed', NULL, 1, 'INGEST_UNSUPPORTED_SOURCE', 'created')",
    );
    legacy.close();

    const db = openDatabase(join(root, "db.sqlite"), APPLIED_AT);
    expect(db.query<{ id: string }, []>("SELECT id FROM items").all()).toEqual([
      { id: "article" },
    ]);
    expect(db.query<{ id: string }, []>("SELECT id FROM annotations").all()).toEqual([
      { id: "keep" },
    ]);
    expect(db.query<{ id: string }, []>("SELECT id FROM fetch_requests").all()).toEqual([
      { id: "web-request" },
    ]);
    expect(db.query<{ item_id: string }, []>("SELECT item_id FROM blocks_fts").all()).toEqual([
      { item_id: "article" },
    ]);
    expect(db.query<{ name: string }, []>("PRAGMA table_info(items)").all().map((row) => row.name)).not.toContain("kind");
    expect(db.query<{ name: string }, []>("PRAGMA table_info(fetch_requests)").all().map((row) => row.name)).not.toContain("source_path");
    db.close();
  });
});

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});
