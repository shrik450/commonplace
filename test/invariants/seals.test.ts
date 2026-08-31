import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { checkSeals, computeSeals } from "../../scripts/seal";

const repoRoot = join(import.meta.dir, "..", "..");
const acceptanceDir = join(repoRoot, "test", "acceptance");

describe("seals invariant", () => {
  test("the recorded seals match the sealed acceptance files", async () => {
    const recorded = (await Bun.file(
      join(acceptanceDir, "seals.json"),
    ).json()) as Record<string, string>;
    const actual = await computeSeals(acceptanceDir);
    expect(checkSeals(recorded, actual)).toEqual({
      ok: true,
      changed: [],
      missing: [],
      extra: [],
    });
  });

  test("checkSeals reports a changed file as a mismatch", () => {
    const result = checkSeals({ "a.test.ts": "aa" }, { "a.test.ts": "bb" });
    expect(result.ok).toBe(false);
    expect(result.changed).toEqual(["a.test.ts"]);
  });
});
