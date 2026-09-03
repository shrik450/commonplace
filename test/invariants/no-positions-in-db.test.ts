import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { migrate, tableInfo, type TableInfo } from "../../src/store/db";
import { EXPECTED_COLUMNS, checkNoPositionsInDb } from "./lib";

function fakeTable(name: string, columns: string[]): TableInfo {
  return {
    name,
    sql: `CREATE TABLE ${name} (${columns.join(", ")})`,
    columns,
  };
}

function schemaTables(): TableInfo[] {
  return Object.entries(EXPECTED_COLUMNS).flatMap(([name, columns]) =>
    columns === undefined ? [] : [fakeTable(name, [...columns])],
  );
}

function migratedTables(): TableInfo[] {
  const db = new Database(":memory:");
  migrate(db, new Date("2026-02-01T00:00:00.000Z"));
  const tables = tableInfo(db);
  db.close();
  return tables;
}

describe("no-positions-in-db invariant", () => {
  test("the migrated schema holds no document position", () => {
    expect(checkNoPositionsInDb(migratedTables())).toEqual([]);
  });

  test("the migrated schema stays clean after ANALYZE", () => {
    const db = new Database(":memory:");
    migrate(db, new Date("2026-02-01T00:00:00.000Z"));
    db.exec("ANALYZE");
    const tables = tableInfo(db);
    db.close();
    expect(checkNoPositionsInDb(tables)).toEqual([]);
  });

  test("checkNoPositionsInDb flags an allowlisted table with an extra column", () => {
    // `locator` passes every name rule, so only the allowlist catches it.
    const tables = schemaTables().map((table) =>
      table.name === "annotations"
        ? fakeTable("annotations", [...table.columns, "locator"])
        : table,
    );
    const violations = checkNoPositionsInDb(tables);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.table).toBe("annotations");
    expect(violations[0]!.rule).toBe("no-positions-in-db");
    expect(violations[0]!.detail).toContain("locator");
  });

  test("checkNoPositionsInDb flags an allowlisted table with a dropped column", () => {
    const tables = schemaTables().map((table) =>
      table.name === "items"
        ? fakeTable("items", table.columns.filter((column) => column !== "author"))
        : table,
    );
    const violations = checkNoPositionsInDb(tables);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.detail).toContain("author");
  });

  test("the name pass flags a position-shaped column on a later table", () => {
    // "later_table" is unpinned, so the call fails it twice: once for being
    // unpinned, once for the column.
    const violations = checkNoPositionsInDb([
      fakeTable("later_table", ["id", "user_id", "node_path"]),
    ]);
    expect(violations).toHaveLength(2);
    expect(
      violations.some((violation) => violation.detail.includes("node_path")),
    ).toBe(true);
  });

  test("every non-exempt table in the live schema has an allowlist entry", () => {
    // Require every table in `EXPECTED_COLUMNS`; otherwise, only the column
    // name check would validate a newly added table.
    const tables = migratedTables();
    const exempt = new Set<string>();
    for (const table of tables) {
      if (/using\s+fts5/i.test(table.sql)) {
        for (const suffix of ["_data", "_idx", "_content", "_docsize", "_config"]) {
          exempt.add(`${table.name}${suffix}`);
        }
      }
    }
    const unlisted = tables
      .map((table) => table.name)
      .filter((name) => !name.startsWith("sqlite_") && !exempt.has(name))
      .filter((name) => EXPECTED_COLUMNS[name] === undefined);
    expect(unlisted).toEqual([]);
  });

  test("checkNoPositionsInDb flags a table the allowlist does not pin", () => {
    // Without this rule a later milestone's table ships unpinned and the
    // allowlist quietly stops meaning anything. A column set the checker
    // does not know is itself a violation, whatever the names are.
    const violations = checkNoPositionsInDb([
      fakeTable("sessions", ["id", "user_id", "expires_at"]),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe("no-positions-in-db");
    expect(violations[0]!.detail).toContain("sessions");
  });

  test("the name pass admits transcript offsets on a pinned table", () => {
    expect([...EXPECTED_COLUMNS.annotations!]).toContain("start_offset");
    expect([...EXPECTED_COLUMNS.annotations!]).toContain("end_offset");
    expect(checkNoPositionsInDb(schemaTables())).toEqual([]);
  });
});
