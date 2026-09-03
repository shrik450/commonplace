import { AppError } from "./errors";

type TomlValue =
  | string
  | number
  | boolean
  | Date
  | null
  | TomlValue[]
  | TomlTable;
type TomlTable = { readonly [key: string]: TomlValue | undefined };

type Config = {
  db_root: string;
  items_root: string;
  base_url: string;
  issuer_url: string;
  client_id: string;
  client_secret: string;
  session_secret: string;
  browser_path: string;
};

const REQUIRED_KEYS = [
  "db_root",
  "items_root",
  "base_url",
  "issuer_url",
  "client_id",
  "client_secret",
  "session_secret",
  "browser_path",
] as const;
type RequiredKey = (typeof REQUIRED_KEYS)[number];

function isTomlString(value: TomlValue | undefined): value is string {
  return typeof value === "string";
}

function requiredString(parsed: TomlTable, key: RequiredKey): string {
  const value = parsed[key];
  if (value === undefined || value === null || value === "") {
    throw new AppError(
      "CONFIG_MISSING_KEY",
      `missing or empty key "${key}"`,
      { key },
    );
  }
  if (!isTomlString(value)) {
    throw new AppError(
      "CONFIG_INVALID_VALUE",
      `"${key}" must be a string`,
      { key },
    );
  }
  return value;
}

export function parseConfig(text: string): Config {
  let parsed: TomlTable;
  try {
    // SAFETY: Bun.TOML.parse returns a table of TOML values, represented by TomlTable.
    parsed = Bun.TOML.parse(text) as TomlTable;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AppError("CONFIG_PARSE_FAILED", message);
  }

  const dbRoot = requiredString(parsed, "db_root");
  const itemsRoot = requiredString(parsed, "items_root");
  const baseUrl = requiredString(parsed, "base_url");
  const issuerUrl = requiredString(parsed, "issuer_url");
  const clientId = requiredString(parsed, "client_id");
  const clientSecret = requiredString(parsed, "client_secret");
  const sessionSecret = requiredString(parsed, "session_secret");

  for (const [key, value] of [["db_root", dbRoot], ["items_root", itemsRoot]] as const) {
    if (!value.startsWith("/")) {
      throw new AppError(
        "CONFIG_INVALID_VALUE",
        `"${key}" must be an absolute path, got "${value}"`,
        { key },
      );
    }
  }

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
  // Reject a trailing slash so derived OpenID Connect redirect URIs exactly
  // match their registered values.
  if (baseUrl.endsWith("/")) {
    throw new AppError(
      "CONFIG_INVALID_VALUE",
      `"base_url" must not end with a slash, got "${baseUrl}"`,
      { key: "base_url" },
    );
  }

  let issuer: URL;
  try {
    issuer = new URL(issuerUrl);
  } catch {
    throw new AppError(
      "CONFIG_INVALID_VALUE",
      `"issuer_url" is not a valid URL, got "${issuerUrl}"`,
      { key: "issuer_url" },
    );
  }
  if (issuer.protocol !== "https:") {
    throw new AppError(
      "CONFIG_INVALID_VALUE",
      `"issuer_url" must use the https: scheme, got "${issuerUrl}"`,
      { key: "issuer_url" },
    );
  }

  if (sessionSecret.length < 32) {
    throw new AppError(
      "CONFIG_INVALID_VALUE",
      `"session_secret" must hold at least 32 characters, got ${sessionSecret.length}`,
      { key: "session_secret" },
    );
  }

  const browserPath = requiredString(parsed, "browser_path");

  return {
    db_root: dbRoot,
    items_root: itemsRoot,
    base_url: baseUrl,
    issuer_url: issuerUrl,
    client_id: clientId,
    client_secret: clientSecret,
    session_secret: sessionSecret,
    browser_path: browserPath,
  };
}

export type { Config };
