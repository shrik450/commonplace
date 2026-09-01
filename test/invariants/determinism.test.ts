import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { checkDeterminism, listSources } from "./lib";

const repoRoot = join(import.meta.dir, "..", "..");

describe("determinism invariant", () => {
  test("the real repository has no stray nondeterminism", async () => {
    const files = await listSources(repoRoot, join(repoRoot, "src"));
    expect(checkDeterminism(files)).toEqual([]);
  });

  test("checkDeterminism flags Date.now outside the clock", () => {
    const violations = checkDeterminism([
      { path: "src/store/db.ts", source: "const t = Date.now();\n" },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe("determinism");
  });

  test("checkDeterminism flags new Date, Bun.randomUUIDv7, and Bun.nanoseconds", () => {
    const violations = checkDeterminism([
      { path: "src/store/db.ts", source: "const t = new Date();\n" },
      {
        path: "src/services/ingest.ts",
        source: "const id = Bun.randomUUIDv7();\n",
      },
      {
        path: "src/store/queue.ts",
        source: "const t = Bun.nanoseconds();\n",
      },
    ]);
    expect(violations).toHaveLength(3);
    for (const violation of violations) {
      expect(violation.rule).toBe("determinism");
    }
  });

  test("checkDeterminism allows clock.ts and ids.ts", () => {
    const violations = checkDeterminism([
      { path: "src/contracts/clock.ts", source: "const t = Date.now();\n" },
      {
        path: "src/contracts/ids.ts",
        source: "const u = crypto.randomUUID();\n",
      },
    ]);
    expect(violations).toEqual([]);
  });

  test("checkDeterminism flags the crypto randomness calls outside the contracts", () => {
    const violations = checkDeterminism([
      {
        path: "src/services/auth.ts",
        source: "const bytes = crypto.getRandomValues(new Uint8Array(16));\n",
      },
      {
        path: "src/services/auth.ts",
        source:
          'const digest = await crypto.subtle.digest("SHA-256", bytes);\n',
      },
      {
        path: "src/store/users.ts",
        source: "const bytes = crypto.randomBytes(16);\n",
      },
    ]);
    expect(violations).toHaveLength(3);
    for (const violation of violations) {
      expect(violation.rule).toBe("determinism");
    }
  });

  test("checkDeterminism allows the crypto randomness calls in ids.ts", () => {
    const violations = checkDeterminism([
      {
        path: "src/contracts/ids.ts",
        source:
          "crypto.getRandomValues(new Uint8Array(16));\n" +
          'await crypto.subtle.digest("SHA-256", bytes);\n' +
          "crypto.randomBytes(16);\n",
      },
    ]);
    expect(violations).toEqual([]);
  });
});
