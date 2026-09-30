import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { blocksOf } from "../../src/contracts/transcript";
import { sanitize } from "../../src/core/sanitize";
import { summarize } from "../../src/core/summarize";
import { walk } from "../../src/core/walk";
import { MIGRATIONS, migrate, openDatabase } from "../../src/store/db";

const APPLIED_AT = new Date("2026-02-01T00:00:00.000Z");
const roots: string[] = [];

describe("database migration behavior", () => {
  test("reopening a migrated database applies nothing again and keeps its rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "commonplace-reopen-"));
    roots.push(root);
    const path = join(root, "db.sqlite");
    const first = openDatabase(path, APPLIED_AT);
    first.run("INSERT INTO users (id, subject, created_at) VALUES ('u', 'reader', 'created')");
    first.close();

    const reopened = openDatabase(path, new Date("2026-03-01T00:00:00.000Z"));
    expect(migrate(reopened, new Date("2026-03-01T00:00:00.000Z"))).toBe(0);
    expect(
      reopened.query<{ applied_at: string }, []>("SELECT DISTINCT applied_at FROM migrations").all(),
    ).toEqual([{ applied_at: APPLIED_AT.toISOString() }]);
    expect(reopened.query<{ id: string }, []>("SELECT id FROM users").all()).toEqual([{ id: "u" }]);
    reopened.close();
  });

  test("maps existing font categories to named choices", async () => {
    const root = await mkdtemp(join(tmpdir(), "commonplace-font-migration-"));
    roots.push(root);
    const legacy = new Database(join(root, "db.sqlite"));
    for (const migration of MIGRATIONS.slice(0, 2)) {
      legacy.exec(migration.sql);
      legacy.run("INSERT INTO migrations (version, applied_at) VALUES (?, ?)", [
        migration.version,
        APPLIED_AT.toISOString(),
      ]);
    }
    legacy.exec("INSERT INTO users (id, subject, created_at) VALUES ('serif-user', 'serif', 'created'), ('sans-user', 'sans', 'created'), ('mono-user', 'mono', 'created')");
    for (const migration of MIGRATIONS.slice(2, 4)) {
      legacy.exec(migration.sql);
      legacy.run("INSERT INTO migrations (version, applied_at) VALUES (?, ?)", [
        migration.version,
        APPLIED_AT.toISOString(),
      ]);
    }
    legacy.exec("UPDATE user_settings SET font = 'sans' WHERE user_id = 'sans-user'; UPDATE user_settings SET font = 'monospace' WHERE user_id = 'mono-user'");
    legacy.close();

    const db = openDatabase(join(root, "db.sqlite"), APPLIED_AT);
    expect(db.query<{ user_id: string; font: string }, []>("SELECT user_id, font FROM user_settings ORDER BY user_id").all()).toEqual([
      { user_id: "mono-user", font: "system-mono" },
      { user_id: "sans-user", font: "system-sans" },
      { user_id: "serif-user", font: "newsreader" },
    ]);
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

describe("summary backfill", () => {
  test("gives items saved before summaries what a new ingest would store", async () => {
    const root = await mkdtemp(join(tmpdir(), "commonplace-summary-backfill-"));
    roots.push(root);
    const legacy = new Database(join(root, "db.sqlite"));
    for (const migration of MIGRATIONS.slice(0, 5)) {
      legacy.exec(migration.sql);
      legacy.run("INSERT INTO migrations (version, applied_at) VALUES (?, ?)", [migration.version, APPLIED_AT.toISOString()]);
    }
    legacy.exec("INSERT INTO users (id, subject, created_at) VALUES ('u', 'reader', 'created')");

    const pages = {
      prose: "<html><body><nav><p>A long navigation paragraph that is not article content, yet runs well beyond eighty characters.</p></nav>" +
        "<article><h1>Title</h1><p>   </p><p>Short.</p><p>" + "Enough prose to quote on a card, well beyond the minimum length for an excerpt. ".repeat(8) + "</p></article></body></html>",
      astral: "<html><body><article><h1>Symbols</h1><p>" + "Mathematical script letters like 𝒜 and 𝒵 count as one character in SQLite. ".repeat(9) + "</p></article></body></html>",
      terse: "<html><body><article><p>Too short to quote.</p></article></body></html>",
    };
    const expected = new Map<string, ReturnType<typeof summarize>>();
    for (const [id, html] of Object.entries(pages)) {
      const { text, map } = walk(sanitize(html));
      expected.set(id, summarize(text, map));
      legacy.run("INSERT INTO items (id, user_id, url, title, author, created_at, ingested_at) VALUES (?, 'u', ?, ?, NULL, 'created', 'created')", [id, `https://example.com/${id}`, id]);
      for (const block of blocksOf(map)) {
        const first = block.runs[0]!;
        const last = block.runs.at(-1)!;
        const blockText = text.slice(first.start, last.end);
        if (blockText.trim() === "") continue;
        legacy.run(
          "INSERT INTO blocks_fts (text, item_id, user_id, block_index, start_offset, end_offset, is_content) VALUES (?, ?, 'u', ?, ?, ?, ?)",
          [blockText, id, block.index, first.start, last.end, first.is_content ? 1 : 0],
        );
      }
    }
    legacy.run("INSERT INTO items (id, user_id, url, title, author, created_at, ingested_at) VALUES ('unindexed', 'u', 'https://example.com/unindexed', 'Unindexed', NULL, 'created', NULL)");
    legacy.close();

    const db = openDatabase(join(root, "db.sqlite"), APPLIED_AT);
    const rows = new Map(
      db.query<{ id: string; excerpt: string; content_length: number }, []>("SELECT id, excerpt, content_length FROM items").all()
        .map((row) => [row.id, { excerpt: row.excerpt, content_length: row.content_length }]),
    );
    expect(rows.get("prose")).toEqual(expected.get("prose")!);
    expect(rows.get("prose")!.excerpt).toStartWith("Enough prose to quote");
    expect(rows.get("terse")).toEqual(expected.get("terse")!);
    expect(rows.get("terse")!.excerpt).toBe("");
    expect(rows.get("unindexed")).toEqual({ excerpt: "", content_length: 0 });
    // SQLite counts an astral-plane character once where JavaScript strings
    // count two UTF-16 units. Both sides count characters, so they agree, and
    // the cut never lands inside one.
    const astral = rows.get("astral")!;
    expect(astral).toEqual(expected.get("astral")!);
    expect([...astral.excerpt]).toHaveLength(400);
    expect(astral.excerpt.isWellFormed()).toBe(true);
    db.close();
  });
});

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});
