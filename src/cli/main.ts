import { access, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { AppError, toLogLine } from "../contracts/errors";
import type { Config } from "../contracts/config";
import { defaultConfigPath, loadConfig } from "../store/config";
import { capture, SINGLE_FILE_BINARY } from "../services/acquire";
import type { CaptureRequest } from "../services/acquire";

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
    throw new AppError("CLI_BAD_URL", `malformed URL "${url}"`, { url });
  }
  const pathPart = parsed.pathname
    .replace(/^\/+|\/+$/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-");
  return pathPart ? `${parsed.hostname}-${pathPart}.html` : `${parsed.hostname}.html`;
}

// Captures every URL in urls.txt into test/fixtures/real/. One failing URL
// does not abort the rest; the exit code reports the outcome. The capture
// function is injectable so tests can run this without the network.
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
      console.log(`captured ${url} -> ${result.path} (${result.bytes} bytes)`);
    } catch (error) {
      failures += 1;
      console.error(toLogLine("error", error, { url }));
    }
  }

  if (failures > 0) {
    console.error(
      `fixtures capture: ${failures} of ${urls.length} captures failed`,
    );
  }
  return failures > 0 ? 1 : 0;
}

async function run(argv: string[]): Promise<number> {
  const positionals: string[] = [];
  let configPath: string | undefined;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") {
      json = true;
    } else if (arg === "--config") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new AppError(
          "CLI_BAD_ARGUMENT",
          '"--config" requires a path',
          { flag: "--config" },
        );
      }
      configPath = value;
      i++;
    } else if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
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
      "no command given; expected one of: doctor, fixtures",
    );
  }
  if (command === "fixtures") {
    const subcommand = positionals.shift();
    if (subcommand !== "capture") {
      throw new AppError(
        "CLI_UNKNOWN_COMMAND",
        `unknown fixtures subcommand "${subcommand ?? ""}"; expected: capture`,
      );
    }
    if (positionals.length > 0) {
      throw new AppError(
        "CLI_BAD_ARGUMENT",
        `unexpected argument "${positionals[0]}" for command "fixtures"`,
      );
    }
    return fixturesCapture();
  }
  if (positionals.length > 0) {
    throw new AppError(
      "CLI_BAD_ARGUMENT",
      `unexpected argument "${positionals[0]}" for command "${command}"`,
    );
  }
  if (command !== "doctor") {
    throw new AppError(
      "CLI_UNKNOWN_COMMAND",
      `unknown command "${command}"; expected one of: doctor, fixtures`,
    );
  }

  const report = await doctor(configPath);
  if (json) {
    console.log(JSON.stringify(report));
  } else {
    console.log(`doctor: ${report.ok ? "ok" : "failed"}`);
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
