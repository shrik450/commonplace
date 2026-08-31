import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixturesCapture } from "../../src/cli/main";
import type { CaptureRequest } from "../../src/services/acquire";

describe("fixturesCapture", () => {
  test("one malformed URL does not abort the rest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "commonplace-cli-"));
    await writeFile(
      join(dir, "urls.txt"),
      "https://example.com/first\nnot a url\nhttps://example.com/second\n",
    );

    const captured: string[] = [];
    const captureFn = async (request: CaptureRequest) => {
      captured.push(request.url);
      return { path: request.outputPath, bytes: 1024 };
    };

    const exitCode = await fixturesCapture(captureFn, dir);
    expect(captured).toEqual([
      "https://example.com/first",
      "https://example.com/second",
    ]);
    expect(exitCode).toBe(1);
  });
});
