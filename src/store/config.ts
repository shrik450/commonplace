import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { parseConfig, type Config } from "../contracts/config";
import { AppError } from "../contracts/errors";

export function defaultConfigPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const base = env.XDG_CONFIG_HOME ?? join(env.HOME ?? "", ".config");
  return join(base, "commonplace", "config.toml");
}

export async function loadConfig(path?: string): Promise<Config> {
  const configPath = path ?? defaultConfigPath();
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new AppError("CONFIG_FILE_MISSING", message);
    }
    const osCode =
      error instanceof Error && "code" in error ? String(error.code) : "unknown";
    throw new AppError("CONFIG_FILE_UNREADABLE", message, { os_code: osCode });
  }
  return parseConfig(text);
}
