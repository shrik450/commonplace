import { access, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { now } from "../contracts/clock";
import { AppError, toLogLine } from "../contracts/errors";
import { asUserId, newRequestId } from "../contracts/ids";
import type { UserId } from "../contracts/ids";
import type { Config } from "../contracts/config";
import { defaultConfigPath, loadConfig } from "../store/config";
import { openDatabase } from "../store/db";
import { enqueueFetch, claimRequest } from "../store/queue";
import { capture, SINGLE_FILE_BINARY } from "../services/acquire";
import type { CaptureRequest, CaptureResult } from "../services/acquire";
import { ingestRequest } from "../services/ingest";
import { LEASE_MS, applyOutcome } from "../services/worker";

type Check = { name: string; ok: boolean; detail: string };

async function directoryCheck(name: string, path: string): Promise<Check> {
  try {
    const info = await stat(path);
    if (info.isDirectory()) {
      return { name, ok: true, detail: `${path} is a directory` };
    }
    return { name, ok: false, detail: `${path} is not a directory` };
  } catch {
    return { name, ok: false, detail: `${path} does not exist` };
  }
}

async function browserPathCheck(path: string | undefined): Promise<Check> {
  if (!path) {
    return {
      name: "browser_path",
      ok: false,
      detail: "browser_path is not set in the config",
    };
  }
  try {
    await access(path);
    return { name: "browser_path", ok: true, detail: `found browser at ${path}` };
  } catch {
    return {
      name: "browser_path",
      ok: false,
      detail: `${path} does not exist or is not executable`,
    };
  }
}

function singleFileCliCheck(): Check {
  const cliPath = Bun.which(SINGLE_FILE_BINARY);
  if (cliPath) {
    return {
      name: "single_file_cli",
      ok: true,
      detail: `found ${SINGLE_FILE_BINARY} at ${cliPath}`,
    };
  }
  return {
    name: "single_file_cli",
    ok: false,
    detail: `${SINGLE_FILE_BINARY} was not found on PATH`,
  };
}

function unloadableConfigChecks(): Check[] {
  const detail = "config did not load, so this check could not run";
  return [
    { name: "db_root", ok: false, detail },
    { name: "items_root", ok: false, detail },
    { name: "browser_path", ok: false, detail },
  ];
}

export async function doctor(
  configPath?: string,
): Promise<{ ok: boolean; checks: Check[] }> {
  const checks: Check[] = [];
  let config: Config | undefined;
  const path = configPath ?? defaultConfigPath();

  try {
    config = await loadConfig(path);
    checks.push({ name: "config", ok: true, detail: `loaded ${path}` });
    checks.push(await directoryCheck("db_root", config.db_root));
    checks.push(await directoryCheck("items_root", config.items_root));
    checks.push(await browserPathCheck(config.browser_path));
  } catch (error) {
    const message = error instanceof AppError ? error.code : "load failed";
    const detail = error instanceof Error ? error.message : String(error);
    checks.push({
      name: "config",
      ok: false,
      detail: `${message}: ${detail}`,
    });
    checks.push(...unloadableConfigChecks());
  }

  checks.push(singleFileCliCheck());
  return { ok: checks.every((check) => check.ok), checks };
}

const REPO_ROOT = join(import.meta.dir, "..", "..");
const REAL_FIXTURES_DIR = join(REPO_ROOT, "test", "fixtures", "real");

function captureFilename(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AppError("CLI_BAD_URL", `"${url}" isn't a valid URL`, { url });
  }
  const pathPart = parsed.pathname
    .replace(/^\/+|\/+$/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-");
  return pathPart ? `${parsed.hostname}-${pathPart}.html` : `${parsed.hostname}.html`;
}

// Captures each URL from `urls.txt` into `test/fixtures/real/`. Failures don't
// stop later captures, and the return value reports whether any capture failed.
export async function fixturesCapture(
  captureFn: (request: CaptureRequest) => Promise<{ path: string; bytes: number }> = capture,
  dir: string = REAL_FIXTURES_DIR,
): Promise<number> {
  const urlsPath = join(dir, "urls.txt");
  let text: string;
  try {
    text = await readFile(urlsPath, "utf8");
  } catch {
    throw new AppError("CLI_BAD_ARGUMENT", `cannot read ${urlsPath}`);
  }

  const urls = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  await mkdir(dir, { recursive: true });

  let failures = 0;
  for (const url of urls) {
    try {
      const outputPath = join(dir, captureFilename(url));
      const result = await captureFn({ url, outputPath });
      console.log(`Captured ${url} to ${result.path} (${result.bytes} bytes)`);
    } catch (error) {
      failures += 1;
      console.error(toLogLine("error", error, { url }));
    }
  }

  if (failures > 0) {
    console.error(
      `Fixture capture failed for ${failures} of ${urls.length} URLs`,
    );
  }
  return failures > 0 ? 1 : 0;
}

// Runs one ingest in the foreground. Require an explicit user ID so the
// command can't select a tenant implicitly.
export async function ingestCommand(options: {
  url: string;
  user: string | undefined;
  json: boolean;
  configPath?: string;
  captureFn?: (request: CaptureRequest) => Promise<CaptureResult>;
}): Promise<number> {
  if (options.user === undefined) {
    throw new AppError(
      "CLI_BAD_ARGUMENT",
      "ingest requires --user <uuid>",
      { flag: "--user" },
    );
  }
  let userId: UserId;
  try {
    userId = asUserId(options.user);
  } catch {
    throw new AppError(
      "CLI_BAD_ARGUMENT",
      "--user must contain a UUID",
      { user: options.user },
    );
  }

  const config = await loadConfig(options.configPath);
  const db = openDatabase(join(config.db_root, "db.sqlite"), now());
  try {
    const request = enqueueFetch(db, {
      id: newRequestId(),
      item_id: null,
      url: options.url,
      source_path: null,
      state: "queued",
      lease_expires_at: null,
      attempts: 0,
      error_code: null,
      created_at: now().toISOString(),
      user_id: userId,
    });
    const deps = {
      db,
      itemsRoot: config.items_root,
      now,
      capture: options.captureFn ?? capture,
      browserPath: config.browser_path,
    };
    // Claim this command's request directly. Claiming the oldest request could
    // process unrelated queued work and leave this command waiting.
    const claimed = claimRequest(db, request.id, now(), LEASE_MS);
    if (claimed === null) {
      throw new AppError(
        "STORE_NOT_FOUND",
        "the new ingest request isn't available to claim",
      );
    }
    const outcome = await ingestRequest(deps, claimed);
    applyOutcome(deps, claimed, outcome);
    if (options.json) {
      if (outcome.state === "done") {
        console.log(
          JSON.stringify({ item_id: outcome.itemId, state: "done" }),
        );
      } else {
        console.log(
          JSON.stringify({ state: outcome.state, code: outcome.code }),
        );
      }
    } else if (outcome.state === "done") {
      console.log(`Ingested ${options.url} as ${outcome.itemId}`);
    } else {
      console.error(
        `ingest ${outcome.state} (${outcome.code}): ${outcome.message}`,
      );
    }
    return outcome.state === "done" ? 0 : 1;
  } finally {
    db.close();
  }
}

async function run(argv: string[]): Promise<number> {
  const positionals: string[] = [];
  let configPath: string | undefined;
  let json = false;
  let user: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") {
      json = true;
    } else if (arg === "--config") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new AppError(
          "CLI_BAD_ARGUMENT",
          "--config requires a path",
          { flag: "--config" },
        );
      }
      configPath = value;
      i++;
    } else if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
    } else if (arg === "--user") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new AppError(
          "CLI_BAD_ARGUMENT",
          "--user requires a UUID",
          { flag: "--user" },
        );
      }
      user = value;
      i++;
    } else if (arg.startsWith("--user=")) {
      user = arg.slice("--user=".length);
    } else if (arg.startsWith("--")) {
      throw new AppError("CLI_BAD_ARGUMENT", `unknown option "${arg}"`);
    } else {
      positionals.push(arg);
    }
  }

  const command = positionals.shift();

  if (command === undefined) {
    throw new AppError(
      "CLI_UNKNOWN_COMMAND",
      "Enter a command: doctor, fixtures, or ingest",
    );
  }
  if (command === "fixtures") {
    const subcommand = positionals.shift();
    if (subcommand !== "capture") {
      throw new AppError(
        "CLI_UNKNOWN_COMMAND",
        `Unknown fixtures subcommand "${subcommand ?? ""}". Use capture.`,
      );
    }
    if (positionals.length > 0) {
      throw new AppError(
        "CLI_BAD_ARGUMENT",
        `Command fixtures doesn't accept "${positionals[0]}"`,
      );
    }
    return fixturesCapture();
  }
  if (command === "ingest") {
    const url = positionals.shift();
    if (url === undefined) {
      throw new AppError(
        "CLI_BAD_ARGUMENT",
        "ingest requires a URL",
        { flag: "url" },
      );
    }
    if (positionals.length > 0) {
      throw new AppError(
        "CLI_BAD_ARGUMENT",
        `Command ingest doesn't accept "${positionals[0]}"`,
      );
    }
    return ingestCommand({ url, user, json, configPath });
  }
  if (positionals.length > 0) {
    throw new AppError(
      "CLI_BAD_ARGUMENT",
      `Command ${command} doesn't accept "${positionals[0]}"`,
    );
  }
  if (command !== "doctor") {
    throw new AppError(
      "CLI_UNKNOWN_COMMAND",
      `Unknown command "${command}". Use doctor, fixtures, or ingest.`,
    );
  }

  const report = await doctor(configPath);
  if (json) {
    console.log(JSON.stringify(report));
  } else {
    console.log(`Doctor: ${report.ok ? "passed" : "failed"}`);
    for (const check of report.checks) {
      console.log(`  ${check.ok ? "pass" : "FAIL"} ${check.name}: ${check.detail}`);
    }
  }
  return report.ok ? 0 : 1;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  try {
    process.exit(await run(argv));
  } catch (error) {
    console.error(toLogLine("error", error));
    process.exit(1);
  }
}
