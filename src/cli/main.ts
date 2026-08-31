import { access, stat } from "node:fs/promises";
import { AppError, toLogLine } from "../contracts/errors";
import type { Config } from "../contracts/config";
import { defaultConfigPath, loadConfig } from "../store/config";

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
  const cliPath = Bun.which("single-file-cli");
  if (cliPath) {
    return {
      name: "single_file_cli",
      ok: true,
      detail: `found single-file-cli at ${cliPath}`,
    };
  }
  return {
    name: "single_file_cli",
    ok: false,
    detail: "single-file-cli was not found on PATH",
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

async function run(argv: string[]): Promise<number> {
  let command: string | undefined;
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
    } else if (command === undefined) {
      command = arg;
    } else {
      throw new AppError(
        "CLI_BAD_ARGUMENT",
        `unexpected argument "${arg}" for command "${command}"`,
      );
    }
  }

  if (command === undefined) {
    throw new AppError(
      "CLI_UNKNOWN_COMMAND",
      "no command given; expected one of: doctor",
    );
  }
  if (command !== "doctor") {
    throw new AppError(
      "CLI_UNKNOWN_COMMAND",
      `unknown command "${command}"; expected one of: doctor`,
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

const argv = process.argv.slice(2);
try {
  process.exit(await run(argv));
} catch (error) {
  console.error(toLogLine("error", error));
  process.exit(1);
}
