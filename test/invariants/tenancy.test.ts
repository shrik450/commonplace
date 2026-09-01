import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { migrate, tableInfo, type TableInfo } from "../../src/store/db";
import { checkTenancy } from "./lib";

function fakeTable(name: string, columns: string[]): TableInfo {
  return {
    name,
    sql: `CREATE TABLE ${name} (${columns.join(", ")})`,
    columns,
  };
}

function fakeFtsTable(name: string, columns: string[]): TableInfo {
  return {
    name,
    sql: `CREATE VIRTUAL TABLE ${name} USING fts5(${columns.join(", ")})`,
    columns,
  };
}

function migratedTables(): TableInfo[] {
  const db = new Database(":memory:");
  migrate(db, new Date("2026-02-01T00:00:00.000Z"));
  const tables = tableInfo(db);
  db.close();
  return tables;
}

describe("tenancy invariant", () => {
  test("the migrated schema puts user_id on every tenant table", () => {
    expect(checkTenancy(migratedTables())).toEqual([]);
  });

  test("the migrated schema stays clean after ANALYZE", () => {
    const db = new Database(":memory:");
    migrate(db, new Date("2026-02-01T00:00:00.000Z"));
    db.exec("ANALYZE");
    const tables = tableInfo(db);
    db.close();
    expect(tables.some((table) => table.name === "sqlite_stat1")).toBe(true);
    expect(checkTenancy(tables)).toEqual([]);
  });

  test("checkTenancy flags a tenant table with no user_id column", () => {
    // The check exists: deleting it would turn this into an empty array.
    const violations = checkTenancy([
      fakeTable("tags", ["id", "label", "created_at"]),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.table).toBe("tags");
    expect(violations[0]!.rule).toBe("tenancy");
  });

  test("checkTenancy exempts migrations, users, and the FTS5 shadow set", () => {
    const tables = [
      fakeTable("migrations", ["version", "applied_at"]),
      fakeTable("users", ["id", "subject", "email", "created_at"]),
      fakeTable("sqlite_stat1", ["tbl", "idx", "stat"]),
      fakeFtsTable("items_fts", ["title", "transcript", "item_id", "user_id"]),
      fakeTable("items_fts_data", ["id", "block"]),
      fakeTable("items_fts_idx", ["id", "segid", "term"]),
      fakeTable("items_fts_content", ["id", "c0", "c1", "c2", "c3"]),
      fakeTable("items_fts_docsize", ["id", "sz"]),
      fakeTable("items_fts_config", ["k", "v"]),
    ];
    expect(checkTenancy(tables)).toEqual([]);
  });

  test("checkTenancy flags items_fts itself, which carries no user_id here", () => {
    const tables = [
      fakeFtsTable("items_fts", ["title", "transcript", "item_id"]),
      fakeTable("items_fts_data", ["id", "block"]),
      fakeTable("items_fts_idx", ["id", "segid", "term"]),
      fakeTable("items_fts_content", ["id", "c0", "c1", "c2"]),
      fakeTable("items_fts_docsize", ["id", "sz"]),
      fakeTable("items_fts_config", ["k", "v"]),
    ];
    const violations = checkTenancy(tables);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.table).toBe("items_fts");
  });

  test("checkTenancy flags a name that only looks like a shadow table", () => {
    const violations = checkTenancy([
      fakeTable("items_fts_notes", ["id", "body"]),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.table).toBe("items_fts_notes");
  });
});
