import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { CAPTURE_ROUTE, checkCaptureCsp, listSources } from "./lib";

const repoRoot = join(import.meta.dir, "..", "..");

describe("capture-csp invariant", () => {
  test("the real capture route sends script-src 'none'", async () => {
    const files = await listSources(repoRoot, join(repoRoot, "src"));
    expect(checkCaptureCsp(files)).toEqual([]);
  });

  test("checkCaptureCsp flags a capture route with no policy", () => {
    const violations = checkCaptureCsp([
      {
        path: "src/web/routes/item.tsx",
        source: `app.get("${CAPTURE_ROUTE}", () => new Response(html));\n`,
      },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe("capture-csp");
  });

  test("checkCaptureCsp flags a policy that belongs to another route", () => {
    const violations = checkCaptureCsp([
      {
        path: "src/web/routes/item.tsx",
        source:
          `app.get("${CAPTURE_ROUTE}", () => new Response(html))\n` +
          `  .get("/items/:id/raw", () => new Response(text, {\n` +
          `    headers: { "content-security-policy": "script-src 'none'" },\n` +
          `  }));\n`,
      },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.detail).toContain("script-src");
  });

  test("checkCaptureCsp flags a missing capture route", () => {
    const violations = checkCaptureCsp([
      { path: "src/web/routes/item.tsx", source: 'app.get("/library", h);\n' },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.detail).toContain("found 0");
  });
});
