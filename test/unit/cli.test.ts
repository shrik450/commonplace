import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestCommand } from "../../src/cli/main";
import { now } from "../../src/contracts/clock";
import { asUserId } from "../../src/contracts/ids";
import { openDatabase } from "../../src/store/db";
import { insertUser } from "../../src/store/users";
import type { CaptureRequest } from "../../src/services/acquire";

const USER_ID = "11111111-1111-4111-8111-111111111111";

const PAGE = `<!DOCTYPE html><html><head>
<title>The Document Title</title></head>
<body><article><p>Prose with enough words to become a transcript of real length.</p></article></body></html>`;

async function configFor(root: string): Promise<string> {
  const dbRoot = join(root, "db");
  const itemsRoot = join(root, "items");
  await mkdir(dbRoot, { recursive: true });
  await mkdir(itemsRoot, { recursive: true });
  const path = join(root, "config.toml");
  await writeFile(
    path,
    `db_root = "${dbRoot}"\nitems_root = "${itemsRoot}"\nbase_url = "https://reader.example.com"\nissuer_url = "https://accounts.example.com"\nclient_id = "cli"\nclient_secret = "secret"\nsession_secret = "${"x".repeat(32)}"\nbrowser_path = "/usr/bin/chromium"\n`,
  );
  return path;
}

function fakeCapture(): (request: CaptureRequest) => Promise<{ path: string; bytes: number }> {
  return async (request) => {
    await writeFile(request.outputPath, PAGE);
    return { path: request.outputPath, bytes: PAGE.length };
  };
}

async function seedUser(root: string): Promise<void> {
  const db = openDatabase(join(root, "db", "db.sqlite"), now());
  insertUser(db, {
    id: asUserId(USER_ID),
    subject: "alice",
    email: "alice@example.com",
    created_at: now().toISOString(),
  });
  db.close();
}

describe("ingestCommand", () => {
  test("fails with CLI_BAD_ARGUMENT when --user is missing", async () => {
    let caught: unknown;
    try {
      await ingestCommand({ url: "https://example.com/a", user: undefined, json: false });
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe("CLI_BAD_ARGUMENT");
  });

  test("fails with CLI_BAD_ARGUMENT when --user is not a UUID", async () => {
    let caught: unknown;
    try {
      await ingestCommand({ url: "https://example.com/a", user: "not-a-uuid", json: false });
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe("CLI_BAD_ARGUMENT");
  });

  test("enqueues a request, drains it, and prints the item id", async () => {
    const root = await mkdtemp(join(tmpdir(), "commonplace-ingest-cli-"));
    const configPath = await configFor(root);
    await seedUser(root);

    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (line: string) => lines.push(line);
    let exitCode: number;
    try {
      exitCode = await ingestCommand({
        url: "https://example.com/article",
        user: USER_ID,
        json: true,
        configPath,
        captureFn: fakeCapture(),
      });
    } finally {
      console.log = originalLog;
    }

    expect(exitCode).toBe(0);
    // Logs are diagnostics on stderr; stdout holds only the command's answer.
    expect(lines).toHaveLength(1);
    const printed = JSON.parse(lines[0]!) as { item_id: string; state: string };
    expect(printed.state).toBe("done");

    const transcript = await readFile(
      join(root, "items", USER_ID, printed.item_id, "transcript.txt"),
      "utf8",
    );
    expect(transcript).toContain("transcript of real length");
  });

  test("--json puts exactly one line that parses as JSON on stdout", async () => {
    const root = await mkdtemp(join(tmpdir(), "commonplace-ingest-cli-"));
    const configPath = await configFor(root);
    await seedUser(root);

    const stdout: string[] = [];
    const stderr: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (line: string) => stdout.push(line);
    console.error = (line: string) => stderr.push(line);
    let exitCode: number;
    try {
      exitCode = await ingestCommand({
        url: "https://example.com/another",
        user: USER_ID,
        json: true,
        configPath,
        captureFn: fakeCapture(),
      });
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    expect(exitCode).toBe(0);
    expect(stdout).toHaveLength(1);
    expect(() => JSON.parse(stdout[0]!)).not.toThrow();
  });
});
