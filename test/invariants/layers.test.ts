import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { checkLayers, collectImports, listSources } from "./lib";

const repoRoot = join(import.meta.dir, "..", "..");

describe("layers invariant", () => {
  test("the real repository has no layer violations", async () => {
    const files = await listSources(repoRoot, join(repoRoot, "src"));
    const edges = files.flatMap((file) =>
      collectImports(file.path, file.source),
    );
    expect(checkLayers(edges)).toEqual([]);
  });

  test("checkLayers flags a core file importing the store", () => {
    const violations = checkLayers([
      { from: "src/core/walk.ts", to: "../store/db.ts", line: 1 },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe("layers");
    expect(violations[0]!.file).toBe("src/core/walk.ts");
  });

  test("checkLayers flags web importing cli", () => {
    const violations = checkLayers([
      { from: "src/web/server.ts", to: "../cli/main.ts", line: 3 },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe("layers");
  });

  test("checkLayers sees an import type statement", () => {
    const edges = collectImports(
      "src/core/walk.ts",
      `import type { Db } from "../store/db";\n`,
    );
    const violations = checkLayers(edges);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe("layers");
  });

  test("checkLayers sees an inline type specifier", () => {
    const edges = collectImports(
      "src/core/walk.ts",
      `import { type Row } from "../web/server";\n`,
    );
    const violations = checkLayers(edges);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe("layers");
  });

  test("checkLayers sees an export type statement", () => {
    const edges = collectImports(
      "src/core/walk.ts",
      `export type { A } from "../web/server";\n`,
    );
    const violations = checkLayers(edges);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe("layers");
  });
});
