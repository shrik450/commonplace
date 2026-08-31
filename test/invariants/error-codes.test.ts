import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { checkErrorThrows, listSources } from "./lib";

const repoRoot = join(import.meta.dir, "..", "..");

describe("error-codes invariant", () => {
  test("the real repository throws no bare Errors", async () => {
    const files = await listSources(repoRoot, join(repoRoot, "src"));
    expect(checkErrorThrows(files)).toEqual([]);
  });

  test("checkErrorThrows flags a bare Error", () => {
    const violations = checkErrorThrows([
      { path: "src/cli/main.ts", source: 'throw new Error("boom");\n' },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe("error-codes");
    expect(violations[0]!.file).toBe("src/cli/main.ts");
    expect(violations[0]!.line).toBe(1);
  });
});
