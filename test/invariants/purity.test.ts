import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { checkPurity, checkPurityGlobals, collectImports, listSources } from "./lib";

const repoRoot = join(import.meta.dir, "..", "..");

describe("purity invariant", () => {
  test("the real repository has no purity violations", async () => {
    const files = await listSources(repoRoot, join(repoRoot, "src"));
    const edges = files.flatMap((file) =>
      collectImports(file.path, file.source),
    );
    expect(checkPurity(edges)).toEqual([]);
  });

  test("checkPurity flags a core file importing node:fs", () => {
    const violations = checkPurity([
      { from: "src/core/walk.ts", to: "node:fs", line: 1 },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe("purity");
  });

  test("checkPurity flags a core file importing a higher layer", () => {
    const violations = checkPurity([
      { from: "src/core/walk.ts", to: "../store/db.ts", line: 2 },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe("purity");
  });

  test("checkPurity catches a type-only import of node:fs", () => {
    const edges = collectImports(
      "src/core/walk.ts",
      `import type { ReadStream } from "node:fs";\n`,
    );
    const violations = checkPurity(edges);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe("purity");
  });

  test("the real repository keeps Bun I/O globals out of src/core/", async () => {
    const files = await listSources(repoRoot, join(repoRoot, "src"));
    expect(checkPurityGlobals(files)).toEqual([]);
  });

  test("checkPurityGlobals flags I/O globals inside core", () => {
    const violations = checkPurityGlobals([
      {
        path: "src/core/walk.ts",
        source: `const html = await Bun.file(path).text();\nconst r = await fetch(url);\n`,
      },
    ]);
    expect(violations).toHaveLength(2);
    for (const violation of violations) {
      expect(violation.rule).toBe("purity");
    }
  });

  test("checkPurityGlobals ignores prefetch identifiers", () => {
    const violations = checkPurityGlobals([
      {
        path: "src/core/walk.ts",
        source: "const link = prefetch(url);\n",
      },
    ]);
    expect(violations).toEqual([]);
  });
});
