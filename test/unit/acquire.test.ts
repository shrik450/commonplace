import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isAppError } from "../../src/contracts/errors";
import { BLOCKED_URL_PATTERNS, buildArgs, capture } from "../../src/services/acquire";

const url = "https://example.com/article";
const browserPath = "/usr/bin/chromium";

async function executable(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "commonplace-acquire-"));
  const path = join(dir, "single-file");
  await writeFile(path, `#!/bin/bash\noutput="\${@: -1}"\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

describe("capture", () => {
  test("passes URL and output path to the executable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "commonplace-acquire-argv-"));
    const argvPath = join(dir, "argv");
    const outputPath = join(dir, "capture.html");
    const binaryPath = await executable(
      `printf '%s\\n' "$@" > "${argvPath}"\n` +
        `for i in $(seq 1 600); do printf x >> "$output"; done`,
    );

    await capture({ url, browserPath, outputPath, binaryPath });

    const argv = (await readFile(argvPath, "utf8")).trimEnd().split("\n");
    expect(argv.slice(-2)).toEqual([url, outputPath]);
  });

  test("passes URL immediately before the positional output path", () => {
    const args = buildArgs({ url, browserPath, outputPath: "/tmp/capture.html" });
    expect(args.slice(-2)).toEqual([url, "/tmp/capture.html"]);
    expect(args).not.toContain("--output");
  });

  test("forwards browser and blocked URL options", () => {
    const args = buildArgs({ url, outputPath: "/tmp/capture.html", browserPath: "/usr/bin/chromium" });
    expect(buildArgs({ url, browserPath, outputPath: "/tmp/capture.html" })).toContain("--browser-executable-path");
    expect(args).toContain("--browser-executable-path");
    expect(args).toContain("/usr/bin/chromium");
    for (const pattern of BLOCKED_URL_PATTERNS) expect(args).toContain(pattern);
  });

  test("reports a non-zero tool exit as an acquire error", async () => {
    const binaryPath = await executable('echo "browser failed" >&2\nexit 3');
    let error: unknown;
    try {
      await capture({ url, browserPath, outputPath: "/tmp/capture.html", binaryPath });
    } catch (caught) {
      error = caught;
    }
    expect(isAppError(error)).toBe(true);
    if (!isAppError(error)) return;
    expect(error.code).toBe("ACQUIRE_FAILED");
  });

  test("rejects a successful run that did not produce a real capture", async () => {
    const binaryPath = await executable("printf 'too small' > \"$output\"");
    const outputPath = join(tmpdir(), "commonplace-tiny.html");
    await expect(capture({ url, browserPath, outputPath, binaryPath })).rejects.toMatchObject({
      code: "ACQUIRE_FAILED",
    });
    expect((await stat(outputPath)).size).toBeLessThan(512);
  });

  test("stops a capture that exceeds its timeout", async () => {
    const binaryPath = await executable("sleep 30");
    await expect(capture({ url, browserPath, outputPath: "/tmp/capture.html", binaryPath, timeoutMs: 100 })).rejects.toMatchObject({
      code: "ACQUIRE_TIMEOUT",
    });
  });
});
