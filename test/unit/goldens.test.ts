import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertGolden,
  goldenPath,
  readGolden,
  writeGolden,
} from "../support/goldens";

// The goldens here write into a temporary root, never into the real fixtures.
const root = await mkdtemp(join(tmpdir(), "commonplace-goldens-"));

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("goldens harness", () => {
  test("goldenPath honors the root override", () => {
    expect(goldenPath("blocks", "transcript.txt", root)).toBe(
      join(root, "blocks", "transcript.txt"),
    );
  });

  test("a changed golden fails with the first differing line", async () => {
    await writeGolden("blocks", "transcript.txt", "one\ntwo\nthree\n", root);
    let message = "";
    try {
      await assertGolden("blocks", "transcript.txt", "one\nWRONG\nthree\n", root);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("line 2");
    expect(message).toContain(goldenPath("blocks", "transcript.txt", root));
  });

  test("a changed golden still fails when UPDATE_GOLDENS is unset by the env", async () => {
    // UPDATE_GOLDENS must be read per call, never cached at import time.
    const previous = process.env.UPDATE_GOLDENS;
    delete process.env.UPDATE_GOLDENS;
    await writeGolden("blocks", "transcript.txt", "keep\n", root);
    let failed = false;
    try {
      await assertGolden("blocks", "transcript.txt", "changed\n", root);
    } catch {
      failed = true;
    } finally {
      if (previous === undefined) {
        delete process.env.UPDATE_GOLDENS;
      } else {
        process.env.UPDATE_GOLDENS = previous;
      }
    }
    expect(failed).toBe(true);
  });

  test("writeGolden creates nested parent directories", async () => {
    await writeGolden("a/b", "golden.txt", "nested\n", root);
    expect(await readGolden("a/b", "golden.txt", root)).toBe("nested\n");
  });
});
