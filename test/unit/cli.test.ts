import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { doctor, ingestCommand } from "../../src/cli/main";
import { now } from "../../src/contracts/clock";
import { asUserId } from "../../src/contracts/ids";
import type { CaptureRequest } from "../../src/services/acquire";
import { openDatabase } from "../../src/store/db";
import { insertUser } from "../../src/store/users";

const repoRoot = join(import.meta.dir, "..", "..");
const USER_ID = asUserId("11111111-1111-4111-8111-111111111111");
const PAGE = "<html><body><article><p>Enough prose to become a transcript of real length.</p></article></body></html>";
const roots: string[] = [];

async function configFor(root: string): Promise<string> {
  const dbRoot = join(root, "db");
  const itemsRoot = join(root, "items");
  await mkdir(dbRoot, { recursive: true });
  await mkdir(itemsRoot, { recursive: true });
  const path = join(root, "config.toml");
  await writeFile(path, [
    `db_root = ${JSON.stringify(dbRoot)}`,
    `items_root = ${JSON.stringify(itemsRoot)}`,
    'base_url = "https://reader.example.com"',
    'issuer_url = "https://accounts.example.com"',
    'client_id = "cli"',
    'client_secret = "secret"',
    `session_secret = "${"x".repeat(32)}"`,
    'browser_path = "/usr/bin/chromium"',
  ].join("\n"));
  return path;
}

async function seedUser(root: string): Promise<void> {
  const db = openDatabase(join(root, "db", "db.sqlite"), now());
  insertUser(db, {
    id: USER_ID,
    subject: "alice",
    email: "alice@example.com",
    created_at: now().toISOString(),
  });
  db.close();
}

function fakeCapture(): (request: CaptureRequest) => Promise<{ path: string; bytes: number }> {
  return async (request) => {
    await writeFile(request.outputPath, PAGE);
    return { path: request.outputPath, bytes: PAGE.length };
  };
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = Bun.spawn({
    cmd: [process.execPath, "run", join(repoRoot, "src", "cli", "main.ts"), ...args],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

describe("operator CLI behavior", () => {
  test("ingest command rejects missing or invalid users", async () => {
    await expect(ingestCommand({ url: "https://example.com/a", user: undefined, json: false })).rejects.toMatchObject({ code: "CLI_BAD_ARGUMENT" });
    await expect(ingestCommand({ url: "https://example.com/a", user: "not-a-uuid", json: false })).rejects.toMatchObject({ code: "CLI_BAD_ARGUMENT" });
  });

  test("ingest command drains one request and returns JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "commonplace-cli-ingest-"));
    roots.push(root);
    const configPath = await configFor(root);
    await seedUser(root);
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => output.push(args.join(" "));
    try {
      expect(await ingestCommand({
        url: "https://example.com/article",
        user: String(USER_ID),
        json: true,
        configPath,
        captureFn: fakeCapture(),
      })).toBe(0);
    } finally {
      console.log = originalLog;
    }
    expect(output).toHaveLength(1);
    const result = JSON.parse(output[0]!) as { item_id: string; state: string };
    expect(result.state).toBe("done");
    expect(await readFile(join(root, "items", String(USER_ID), result.item_id, "transcript.txt"), "utf8")).toContain("transcript of real length");
  });

  test("doctor reports a configuration failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "commonplace-cli-doctor-"));
    roots.push(root);
    const path = join(root, "config.toml");
    await writeFile(path, 'db_root = "/tmp/db"\n');
    const report = await doctor(path);
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === "config")).toMatchObject({
      ok: false,
      detail: expect.stringContaining("CONFIG_MISSING_KEY"),
    });
  });

  test("unknown commands exit with a stable error", async () => {
    const result = await runCli(["nonsense"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain("CLI_UNKNOWN_COMMAND");
  }, 20_000);
});
