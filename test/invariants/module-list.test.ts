import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { checkModuleList, listSources } from "./lib";

const repoRoot = join(import.meta.dir, "..", "..");

describe("module-list invariant", () => {
  test("every file under src/ is in the module list", async () => {
    const files = await listSources(repoRoot, join(repoRoot, "src"));
    expect(checkModuleList(files)).toEqual([]);
  });

  test("checkModuleList flags a file outside the module list", () => {
    const violations = checkModuleList([{ path: "src/util/helpers.ts" }]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe("module-list");
  });

  test("checkModuleList flags a src file that maps to no layer", () => {
    const violations = checkModuleList([{ path: "src/contracts.ts" }]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe("module-list");
  });

  test("files under a named view prefix are allowed", () => {
    expect(checkModuleList([{ path: "src/web/views/new-page.tsx" }])).toEqual(
      [],
    );
  });
});
