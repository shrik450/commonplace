import { AppError } from "./errors";

export type Config = {
  db_root: string;
  items_root: string;
  base_url: string;
  issuer_url: string;
  client_id: string;
  client_secret: string;
  session_secret: string;
  browser_path?: string;
};

const REQUIRED_KEYS = [
  "db_root",
  "items_root",
  "base_url",
  "issuer_url",
  "client_id",
  "client_secret",
  "session_secret",
] as const;

export function parseConfig(text: string): Config {
  let parsed: Record<string, unknown>;
  try {
    parsed = Bun.TOML.parse(text) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AppError("CONFIG_PARSE_FAILED", message);
  }

  const config: Record<string, unknown> = {};
  for (const key of REQUIRED_KEYS) {
    const value = parsed[key];
    if (value === undefined || value === null || value === "") {
      throw new AppError(
        "CONFIG_MISSING_KEY",
        `missing or empty key "${key}"`,
        { key },
      );
    }
    if (typeof value !== "string") {
      throw new AppError(
        "CONFIG_INVALID_VALUE",
        `"${key}" must be a string, got ${typeof value}`,
        { key },
      );
    }
    config[key] = value;
  }

  for (const key of ["db_root", "items_root"] as const) {
    const value = config[key] as string;
    if (!value.startsWith("/")) {
      throw new AppError(
        "CONFIG_INVALID_VALUE",
        `"${key}" must be an absolute path, got "${value}"`,
        { key },
      );
    }
  }

  const baseUrl = config.base_url as string;
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new AppError(
      "CONFIG_INVALID_VALUE",
      `"base_url" is not an absolute URL, got "${baseUrl}"`,
      { key: "base_url" },
    );
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new AppError(
      "CONFIG_INVALID_VALUE",
      `"base_url" must use the http: or https: scheme, got "${baseUrl}"`,
      { key: "base_url" },
    );
  }
  // A trailing slash turns every joined path into a double slash, and an
  // OIDC redirect_uri must match the registered value byte for byte.
  if (baseUrl.endsWith("/")) {
    throw new AppError(
      "CONFIG_INVALID_VALUE",
      `"base_url" must not end with a slash, got "${baseUrl}"`,
      { key: "base_url" },
    );
  }

  const issuerUrl = config.issuer_url as string;
  let url: URL;
  try {
    url = new URL(issuerUrl);
  } catch {
    throw new AppError(
      "CONFIG_INVALID_VALUE",
      `"issuer_url" is not a valid URL, got "${issuerUrl}"`,
      { key: "issuer_url" },
    );
  }
  if (url.protocol !== "https:") {
    throw new AppError(
      "CONFIG_INVALID_VALUE",
      `"issuer_url" must use the https: scheme, got "${issuerUrl}"`,
      { key: "issuer_url" },
    );
  }

  const sessionSecret = config.session_secret as string;
  if (sessionSecret.length < 32) {
    throw new AppError(
      "CONFIG_INVALID_VALUE",
      `"session_secret" must hold at least 32 characters, got ${sessionSecret.length}`,
      { key: "session_secret" },
    );
  }

  if (parsed.browser_path !== undefined) {
    if (
      typeof parsed.browser_path !== "string" ||
      parsed.browser_path === ""
    ) {
      throw new AppError(
        "CONFIG_INVALID_VALUE",
        '"browser_path" must be a non-empty string when present',
        { key: "browser_path" },
      );
    }
    config.browser_path = parsed.browser_path;
  }

  return config as unknown as Config;
}
