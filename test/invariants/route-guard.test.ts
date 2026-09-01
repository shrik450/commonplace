import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { checkRouteGuard, listSources } from "./lib";

const repoRoot = join(import.meta.dir, "..", "..");

describe("route-guard invariant", () => {
  test("every real route calls the guard or is listed as unguarded", async () => {
    const files = await listSources(repoRoot, join(repoRoot, "src"));
    expect(checkRouteGuard(files)).toEqual([]);
  });

  test("checkRouteGuard flags an unguarded, unlisted route", () => {
    const violations = checkRouteGuard([
      {
        path: "src/web/server.ts",
        source: 'app.get("/settings", () => new Response("ok"));\n',
      },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe("route-guard");
  });

  test("checkRouteGuard flags a single-quoted unguarded route", () => {
    const violations = checkRouteGuard([
      {
        path: "src/web/server.ts",
        source: "app.get('/settings', () => new Response('ok'));\n",
      },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe("route-guard");
  });

  test("checkRouteGuard flags a backtick unguarded route", () => {
    const violations = checkRouteGuard([
      {
        path: "src/web/server.ts",
        source: "app.get(`/settings`, () => new Response('ok'));\n",
      },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe("route-guard");
  });

  test("checkRouteGuard flags a route whose path is not a literal", () => {
    const violations = checkRouteGuard([
      {
        path: "src/web/server.ts",
        source: 'app.get(settingsPath, () => new Response("ok"));\n',
      },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe("route-guard");
    expect(violations[0]!.detail).toContain("literal");
  });
});
