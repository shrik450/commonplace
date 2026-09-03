import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { parseConfig } from "../../src/contracts/config";
import { AppError, isAppError } from "../../src/contracts/errors";
import { defaultConfigPath, loadConfig } from "../../src/store/config";
import { publicRoutes } from "../../src/web/server";

const fixtureDir = join(import.meta.dir, "..", "fixtures", "config");

function configText(overrides: string[] = []): string {
  return [
    'db_root = "/tmp/commonplace/db"',
    'items_root = "/tmp/commonplace/items"',
    'base_url = "https://reader.example.com"',
    'issuer_url = "https://issuer.example.com"',
    'client_id = "commonplace"',
    'client_secret = "secret"',
    `session_secret = "${"x".repeat(32)}"`,
    'browser_path = "/usr/bin/chromium"',
    ...overrides,
  ].join("\n");
}

function configWith(key: string, value: string): string {
  return configText().replace(
    new RegExp(`^${key} = .*`, "m"),
    `${key} = ${JSON.stringify(value)}`,
  );
}

describe("configuration", () => {
  test("accepts the required settings including browser path", () => {
    const config = parseConfig(configText());
    expect(config.base_url).toBe("https://reader.example.com");
    expect(config.browser_path).toBe("/usr/bin/chromium");
  });

  test("rejects missing browser_path", () => {
    expect(() => parseConfig(configText().replace('browser_path = "/usr/bin/chromium"', ""))).toThrow(AppError);
  });

  test("rejects a missing setting with its stable error code", () => {
    const error = (() => {
      try {
        parseConfig(configText().replace('client_id = "commonplace"\n', ""));
      } catch (caught) {
        return caught;
      }
      return null;
    })();

    expect(error).toBeInstanceOf(AppError);
    expect(isAppError(error)).toBe(true);
    if (!isAppError(error)) return;
    expect(error.code).toBe("CONFIG_MISSING_KEY");
  });

  test("rejects unsafe origins, roots, and secrets", () => {
    const invalid = [
      ["base_url", "https://reader.example.com/"],
      ["db_root", "relative/db"],
      ["items_root", "./items"],
      ["session_secret", "x".repeat(31)],
    ] as const;
    for (const [key, value] of invalid) {
      let error: unknown;
      try {
        parseConfig(configWith(key, value));
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({
        code: "CONFIG_INVALID_VALUE",
        context: { key },
      });
    }
    expect(() =>
      parseConfig(configWith("issuer_url", "http://issuer.example.com")),
    ).toThrow(AppError);
  });

  test("loads configuration from a file and reports malformed TOML", async () => {
    const loaded = await loadConfig(join(fixtureDir, "valid.toml"));
    expect(loaded.client_id).toBe("commonplace-test");
    await expect(loadConfig(join(fixtureDir, "invalid.toml"))).rejects.toMatchObject({
      code: "CONFIG_PARSE_FAILED",
    });
  });

  test("chooses the XDG config path before HOME", () => {
    expect(defaultConfigPath({ XDG_CONFIG_HOME: "/xdg", HOME: "/home/reader" })).toBe(
      "/xdg/commonplace/config.toml",
    );
  });
});

describe("public HTTP behavior", () => {
  const app = publicRoutes();

  test("health returns JSON and the landing page is public", async () => {
    const health = await app.handle(new Request("http://localhost/health"));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    const home = await app.handle(new Request("http://localhost/"));
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("Commonplace");
  });
});
