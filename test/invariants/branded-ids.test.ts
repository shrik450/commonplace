import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { checkBrandedIds, listSources } from "./lib";

const repoRoot = join(import.meta.dir, "..", "..");

describe("branded-ids invariant", () => {
  test("the real repository brands every id parameter and field", async () => {
    const files = await listSources(repoRoot, join(repoRoot, "src"));
    expect(checkBrandedIds(files)).toEqual([]);
  });

  test("checkBrandedIds flags a bare string id", () => {
    const violations = checkBrandedIds([
      {
        path: "src/store/users.ts",
        source:
          "export function getUser(db: Database, id: string): User | null {\n" +
          "  return null;\n" +
          "}\n",
      },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe("branded-ids");
    expect(violations[0]!.file).toBe("src/store/users.ts");
    expect(violations[0]!.line).toBe(1);
  });

  test("checkBrandedIds flags a bare string | null field", () => {
    const violations = checkBrandedIds([
      {
        path: "src/store/queue.ts",
        source: "type Row = { item_id: string | null };\n",
      },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.line).toBe(1);
  });

  test("checkBrandedIds exempts ids.ts and the value parameter", () => {
    const violations = checkBrandedIds([
      {
        path: "src/contracts/ids.ts",
        source: "export function asUserId(value: string): UserId {\n" +
          "  return value as UserId;\n" +
          "}\n",
      },
    ]);
    expect(violations).toEqual([]);
  });
});
