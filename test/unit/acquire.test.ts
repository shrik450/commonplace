import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAppError } from "../../src/contracts/errors";
import {
  BLOCKED_URL_PATTERNS,
  buildArgs,
  capture,
} from "../../src/services/acquire";

const url = "https://example.com/article";
const outputPath = "/tmp/commonplace-unit/capture.html";
const browserPath = "/usr/bin/chromium";

async function writeScript(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "commonplace-acquire-"));
  const path = join(dir, "fake-single-file");
  // The output path is always the last argument of the spawned command.
  await writeFile(path, `#!/bin/bash\noutput="\${@: -1}"\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

describe("buildArgs", () => {
  test("emits url then outputPath as the only positionals", () => {
    const args = buildArgs({ url, outputPath, browserPath });
    const positionals: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
      if (args[i]!.startsWith("-")) {
        i += 1; // skip the flag's value
        continue;
      }
      positionals.push(args[i]!);
    }
    expect(positionals).toEqual([url, outputPath]);
  });

  test("passes the configured browser path", () => {
    const args = buildArgs({ url, outputPath, browserPath });
    const flagIndex = args.indexOf("--browser-executable-path");
    expect(args[flagIndex + 1]).toBe(browserPath);
  });

  test("emits every blocked pattern", () => {
    const args = buildArgs({ url, outputPath, browserPath });
    for (const pattern of BLOCKED_URL_PATTERNS) {
      expect(args).toContain(pattern);
    }
  });
});

describe("capture with an injected binary", () => {
  test("kills the process past the timeout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "commonplace-acquire-kill-"));
    const pidFile = join(dir, "pid");
    const binaryPath = await writeScript(`echo $$ > "${pidFile}"\nsleep 30`);
    const started = performance.now();
    let code: string | undefined;
    try {
      await capture({ url, outputPath, binaryPath, browserPath, timeoutMs: 500 });
    } catch (error) {
      if (isAppError(error)) code = error.code;
    }
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(code).toBe("ACQUIRE_TIMEOUT");

    // The kill is SIGKILL, so the pid stops being alive once the parent reaps
    // it. Poll briefly rather than trusting a single instant check.
    const pid = Number(await readFile(pidFile, "utf8"));
    let gone = false;
    for (let i = 0; i < 50 && !gone; i += 1) {
      try {
        process.kill(pid, 0);
      } catch {
        gone = true;
      }
      if (!gone) await Bun.sleep(20);
    }
    expect(gone).toBe(true);
  });

  test("treats a tiny output file as a failure despite exit 0", async () => {
    const tinyFile = join(tmpdir(), "commonplace-unit-tiny.html");
    const binaryPath = await writeScript(`printf 'too small' > "$output"`);
    let code: string | undefined;
    try {
      await capture({ url, outputPath: tinyFile, binaryPath, browserPath });
    } catch (error) {
      if (isAppError(error)) code = error.code;
    }
    expect(code).toBe("ACQUIRE_FAILED");
    const info = await stat(tinyFile);
    expect(info.size).toBeLessThan(512);
  });

  test("reports a non-zero exit with the exit code and stderr tail", async () => {
    const binaryPath = await writeScript(
      `echo "browser exploded" >&2\nexit 3`,
    );
    let code: string | undefined;
    let context: Record<string, unknown> = {};
    try {
      await capture({ url, outputPath, binaryPath, browserPath });
    } catch (error) {
      if (isAppError(error)) {
        code = error.code;
        context = error.context;
      }
    }
    expect(code).toBe("ACQUIRE_FAILED");
    expect(context.exit_code).toBe(3);
    expect(String(context.stderr)).toContain("browser exploded");
  });

  test("resolves a good capture", async () => {
    const goodFile = join(tmpdir(), "commonplace-unit-good.html");
    const binaryPath = await writeScript(
      `for i in $(seq 1 600); do printf 'x' >> "$output"; done`,
    );
    const result = await capture({ url, outputPath: goodFile, binaryPath, browserPath });
    expect(result.bytes).toBeGreaterThan(512);
    expect(result.path).toBe(goodFile);
  });
});
