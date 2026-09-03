// Acceptance test for milestone 0. It is the specification for that work.
// Change it only when the design changes, and say what changed and why.
//
// Fixtures the implementer must create
// ------------------------------------
// Create exactly these three files under `test/fixtures/config/`.
//
// 1. `test/fixtures/config/valid.toml` — every key present and valid:
//
//      db_root = "/tmp/commonplace-test/db"
//      items_root = "/tmp/commonplace-test/items"
//      base_url = "https://reader.example.com"
//      issuer_url = "https://issuer.example.com"
//      client_id = "commonplace-test"
//      client_secret = "test-client-secret"
//      session_secret = "0123456789abcdef0123456789abcdef"
//      browser_path = "/usr/bin/chromium"
//
// 2. `test/fixtures/config/invalid.toml` — text that `Bun.TOML.parse` rejects:
//
//      db_root = "/tmp/commonplace-test/db
//      items_root =
//
// 3. `test/fixtures/config/missing-key.toml` — the same as `valid.toml`, but
//    with the `client_id` line deleted. Every other key keeps the same value.
//
// The tests read those exact values back, so do not change them.
//
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { AppError, isAppError, toLogLine } from "../../src/contracts/errors";
import { parseConfig } from "../../src/contracts/config";
import { defaultConfigPath, loadConfig } from "../../src/store/config";
import { Fragment, jsx, jsxs, raw } from "../../src/web/views/jsx-runtime";
import { publicRoutes } from "../../src/web/server";

const repoRoot = join(import.meta.dir, "..", "..");
const fixtureDir = join(repoRoot, "test", "fixtures", "config");
const validConfigPath = join(fixtureDir, "valid.toml");

const validConfigText = `
db_root = "/tmp/commonplace-test/db"
items_root = "/tmp/commonplace-test/items"
base_url = "https://reader.example.com"
issuer_url = "https://issuer.example.com"
client_id = "commonplace-test"
client_secret = "test-client-secret"
session_secret = "0123456789abcdef0123456789abcdef"
browser_path = "/usr/bin/chromium"
`;

function configWithout(key: string): string {
  return validConfigText
    .split("\n")
    .filter((line) => !line.startsWith(`${key} =`))
    .join("\n");
}

function configWith(key: string, value: string): string {
  return `${configWithout(key)}\n${key} = ${JSON.stringify(value)}\n`;
}

function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

describe("src/contracts/errors", () => {
  test("AppError carries a code, a message, and context", () => {
    const error = new AppError("CONFIG_MISSING_KEY", "missing key", {
      key: "db_root",
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("CONFIG_MISSING_KEY");
    expect(error.message).toBe("missing key");
    expect(error.context).toEqual({ key: "db_root" });
  });

  test("AppError context defaults to an empty object", () => {
    expect(new AppError("CLI_BAD_ARGUMENT", "bad argument").context).toEqual({});
  });

  test("isAppError accepts an AppError and rejects everything else", () => {
    expect(isAppError(new AppError("CLI_BAD_ARGUMENT", "bad"))).toBe(true);
    expect(isAppError(new Error("bad"))).toBe(false);
    expect(isAppError("CLI_BAD_ARGUMENT")).toBe(false);
    expect(isAppError(null)).toBe(false);
    expect(isAppError(undefined)).toBe(false);
    expect(isAppError({ code: "CLI_BAD_ARGUMENT" })).toBe(false);
  });

  test("toLogLine writes one JSON line with level, code, and msg", () => {
    const line = toLogLine(
      "error",
      new AppError("CONFIG_MISSING_KEY", "missing key", { key: "db_root" }),
    );
    expect(line).not.toContain("\n");

    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.level).toBe("error");
    expect(parsed.code).toBe("CONFIG_MISSING_KEY");
    expect(parsed.msg).toBe("missing key");
    expect(parsed.key).toBe("db_root");
  });

  test("toLogLine merges the extra fields", () => {
    const parsed = JSON.parse(
      toLogLine("warn", new AppError("CONFIG_FILE_MISSING", "no file", { key: "path" }), {
        path: "/etc/commonplace/config.toml",
      }),
    ) as Record<string, unknown>;
    expect(parsed.level).toBe("warn");
    expect(parsed.code).toBe("CONFIG_FILE_MISSING");
    expect(parsed.key).toBe("path");
    expect(parsed.path).toBe("/etc/commonplace/config.toml");
  });

  test("toLogLine uses the code UNKNOWN for a plain Error", () => {
    const parsed = JSON.parse(toLogLine("error", new Error("boom"))) as Record<
      string,
      unknown
    >;
    expect(parsed.code).toBe("UNKNOWN");
    expect(parsed.level).toBe("error");
    expect(String(parsed.msg)).toContain("boom");
  });

  test("toLogLine uses the code UNKNOWN for a non-error value", () => {
    const parsed = JSON.parse(toLogLine("info", "started")) as Record<string, unknown>;
    expect(parsed.code).toBe("UNKNOWN");
    expect(parsed.level).toBe("info");
    expect(String(parsed.msg)).toContain("started");
  });

  test("toLogLine keeps a multiline message on one line", () => {
    const line = toLogLine("error", new AppError("CONFIG_PARSE_FAILED", "line 1\nline 2"));
    expect(line).not.toContain("\n");
    expect(JSON.parse(line).msg).toBe("line 1\nline 2");
  });
});

describe("src/contracts/config parseConfig", () => {
  test("accepts a full config", () => {
    expect(parseConfig(validConfigText)).toEqual({
      db_root: "/tmp/commonplace-test/db",
      items_root: "/tmp/commonplace-test/items",
      base_url: "https://reader.example.com",
      issuer_url: "https://issuer.example.com",
      client_id: "commonplace-test",
      client_secret: "test-client-secret",
      session_secret: "0123456789abcdef0123456789abcdef",
      browser_path: "/usr/bin/chromium",
    });
  });

  test("requires browser_path", () => {
    const error = caught(() => parseConfig(configWithout("browser_path")));
    expect(isAppError(error)).toBe(true);
    expect((error as AppError).code).toBe("CONFIG_MISSING_KEY");
    expect((error as AppError).context.key).toBe("browser_path");
  });

  test("throws CONFIG_PARSE_FAILED for invalid TOML", () => {
    const error = caught(() => parseConfig('db_root = "/tmp/db\nitems_root ='));
    expect(isAppError(error)).toBe(true);
    expect((error as AppError).code).toBe("CONFIG_PARSE_FAILED");
  });

  const requiredKeys = [
    "db_root",
    "items_root",
    "base_url",
    "issuer_url",
    "client_id",
    "client_secret",
    "session_secret",
    "browser_path",
  ];

  for (const key of requiredKeys) {
    test(`throws CONFIG_MISSING_KEY when ${key} is absent`, () => {
      const error = caught(() => parseConfig(configWithout(key)));
      expect(isAppError(error)).toBe(true);
      expect((error as AppError).code).toBe("CONFIG_MISSING_KEY");
      expect((error as AppError).context.key).toBe(key);
    });

    test(`throws CONFIG_MISSING_KEY when ${key} is empty`, () => {
      const error = caught(() => parseConfig(configWith(key, "")));
      expect(isAppError(error)).toBe(true);
      expect((error as AppError).code).toBe("CONFIG_MISSING_KEY");
      expect((error as AppError).context.key).toBe(key);
    });
  }

  test("throws CONFIG_INVALID_VALUE for a relative db_root", () => {
    const error = caught(() => parseConfig(configWith("db_root", "relative/db")));
    expect(isAppError(error)).toBe(true);
    expect((error as AppError).code).toBe("CONFIG_INVALID_VALUE");
    expect((error as AppError).context.key).toBe("db_root");
  });

  test("throws CONFIG_INVALID_VALUE for a relative items_root", () => {
    const error = caught(() => parseConfig(configWith("items_root", "./items")));
    expect(isAppError(error)).toBe(true);
    expect((error as AppError).code).toBe("CONFIG_INVALID_VALUE");
    expect((error as AppError).context.key).toBe("items_root");
  });

  test("throws CONFIG_INVALID_VALUE for an issuer_url that is not a URL", () => {
    const error = caught(() => parseConfig(configWith("issuer_url", "issuer.example.com")));
    expect(isAppError(error)).toBe(true);
    expect((error as AppError).code).toBe("CONFIG_INVALID_VALUE");
    expect((error as AppError).context.key).toBe("issuer_url");
  });

  test("throws CONFIG_INVALID_VALUE for an issuer_url that is not https", () => {
    const error = caught(() =>
      parseConfig(configWith("issuer_url", "http://issuer.example.com")),
    );
    expect(isAppError(error)).toBe(true);
    expect((error as AppError).code).toBe("CONFIG_INVALID_VALUE");
    expect((error as AppError).context.key).toBe("issuer_url");
  });

  test("throws CONFIG_INVALID_VALUE for a short session_secret", () => {
    const error = caught(() => parseConfig(configWith("session_secret", "a".repeat(31))));
    expect(isAppError(error)).toBe(true);
    expect((error as AppError).code).toBe("CONFIG_INVALID_VALUE");
    expect((error as AppError).context.key).toBe("session_secret");
  });

  test("accepts a session_secret of exactly 32 characters", () => {
    const config = parseConfig(configWith("session_secret", "b".repeat(32)));
    expect(config.session_secret).toBe("b".repeat(32));
  });
});

describe("src/store/config", () => {
  test("defaultConfigPath honours XDG_CONFIG_HOME", () => {
    expect(defaultConfigPath({ XDG_CONFIG_HOME: "/xdg", HOME: "/home/alice" })).toBe(
      "/xdg/commonplace/config.toml",
    );
  });

  test("defaultConfigPath falls back to HOME", () => {
    expect(defaultConfigPath({ HOME: "/home/alice" })).toBe(
      "/home/alice/.config/commonplace/config.toml",
    );
  });

  test("loadConfig reads the valid fixture", async () => {
    const config = await loadConfig(validConfigPath);
    expect(config.db_root).toBe("/tmp/commonplace-test/db");
    expect(config.items_root).toBe("/tmp/commonplace-test/items");
    expect(config.issuer_url).toBe("https://issuer.example.com");
    expect(config.client_id).toBe("commonplace-test");
    expect(config.client_secret).toBe("test-client-secret");
    expect(config.session_secret).toBe("0123456789abcdef0123456789abcdef");
    expect(config.browser_path).toBe("/usr/bin/chromium");
  });

  test("loadConfig throws CONFIG_FILE_MISSING for a missing file", async () => {
    const missing = join(fixtureDir, "does-not-exist.toml");
    let error: unknown;
    try {
      await loadConfig(missing);
    } catch (thrown) {
      error = thrown;
    }
    expect(isAppError(error)).toBe(true);
    expect((error as AppError).code).toBe("CONFIG_FILE_MISSING");
  });

  test("loadConfig throws CONFIG_PARSE_FAILED for the invalid fixture", async () => {
    let error: unknown;
    try {
      await loadConfig(join(fixtureDir, "invalid.toml"));
    } catch (thrown) {
      error = thrown;
    }
    expect(isAppError(error)).toBe(true);
    expect((error as AppError).code).toBe("CONFIG_PARSE_FAILED");
  });

  test("loadConfig throws CONFIG_MISSING_KEY for the incomplete fixture", async () => {
    let error: unknown;
    try {
      await loadConfig(join(fixtureDir, "missing-key.toml"));
    } catch (thrown) {
      error = thrown;
    }
    expect(isAppError(error)).toBe(true);
    expect((error as AppError).code).toBe("CONFIG_MISSING_KEY");
    expect((error as AppError).context.key).toBe("client_id");
  });
});

// The runtime is exercised through `jsx`, `jsxs`, and `Fragment` rather than
// TSX syntax. TypeScript only allows JSX syntax in a `.tsx` file, and this
// file must stay `.ts`. The server test below proves the tsconfig wiring,
// because `GET /` renders a TSX page.
//
// A rendered node must turn into HTML through `String(node)`.
describe("src/web/views/jsx-runtime", () => {
  const html = (node: unknown): string => String(node);

  test("renders an element with children", () => {
    expect(html(jsx("p", { children: "hello" }))).toBe("<p>hello</p>");
  });

  test("renders an element with no children", () => {
    expect(html(jsx("div", {}))).toBe("<div></div>");
  });

  test("renders attributes", () => {
    const out = html(jsx("a", { href: "/items", class: "link", children: "Items" }));
    expect(out).toContain('href="/items"');
    expect(out).toContain('class="link"');
    expect(out).toContain(">Items</a>");
  });

  test("escapes text children", () => {
    const out = html(jsx("p", { children: `a & b < c > d " e ' f` }));
    const body = out.slice(out.indexOf(">") + 1, out.lastIndexOf("<"));
    expect(body).toContain("&amp;");
    expect(body).toContain("&lt;");
    expect(body).toContain("&gt;");
    expect(body).toContain("&quot;");
    expect(body).toMatch(/&(#39|#x27|apos);/);
    expect(body).not.toContain("<");
    expect(body).not.toContain(">");
    expect(body).not.toContain('"');
    expect(body).not.toContain("'");
  });

  test("escapes attribute values", () => {
    const out = html(
      jsx("a", { href: `/s?q=a&b`, title: `He said "hi" & <b>'s`, children: "x" }),
    );
    expect(out).toContain("&amp;");
    expect(out).toContain("&lt;");
    expect(out).toContain("&gt;");
    expect(out).toContain("&quot;");
    expect(out).toMatch(/&(#39|#x27|apos);/);

    // The tag must end at the first `>`, which proves the raw `<b>` is gone.
    expect(out.indexOf(">")).toBe(out.indexOf(">x</a>"));
    expect(out).not.toContain("<b>");
    expect(out).not.toContain("'");
  });

  test("raw bypasses escaping", () => {
    expect(html(jsx("div", { children: raw("<b>bold</b>") }))).toBe(
      "<div><b>bold</b></div>",
    );
  });

  test("raw inside an array bypasses escaping", () => {
    const out = html(jsxs("div", { children: [raw("<i>a</i>"), "b & c"] }));
    expect(out).toBe("<div><i>a</i>b &amp; c</div>");
  });

  test("renders null, undefined, false, and true as nothing", () => {
    expect(html(jsx("p", { children: null }))).toBe("<p></p>");
    expect(html(jsx("p", { children: undefined }))).toBe("<p></p>");
    expect(html(jsx("p", { children: false }))).toBe("<p></p>");
    expect(html(jsx("p", { children: true }))).toBe("<p></p>");
    expect(html(jsxs("p", { children: [null, undefined, false, true, "ok"] }))).toBe(
      "<p>ok</p>",
    );
  });

  test("concatenates an array of children", () => {
    const out = html(
      jsxs("ul", {
        children: [jsx("li", { children: "one" }), jsx("li", { children: "two" })],
      }),
    );
    expect(out).toBe("<ul><li>one</li><li>two</li></ul>");
  });

  test("does not escape a nested element", () => {
    expect(html(jsx("div", { children: jsx("span", { children: "x" }) }))).toBe(
      "<div><span>x</span></div>",
    );
  });

  test("renders a function component", () => {
    const Greeting = (props: { name: string }) =>
      jsx("p", { children: `Hello, ${props.name}` });
    expect(html(jsx(Greeting, { name: "Ada" }))).toBe("<p>Hello, Ada</p>");
  });

  test("escapes text a function component returns", () => {
    const Greeting = (props: { name: string }) => jsx("p", { children: props.name });
    expect(html(jsx(Greeting, { name: "<script>" }))).toBe(
      "<p>&lt;script&gt;</p>",
    );
  });

  test("renders a fragment without a wrapper tag", () => {
    const out = html(
      jsxs(Fragment, { children: [jsx("p", { children: "a" }), jsx("p", { children: "b" })] }),
    );
    expect(out).toBe("<p>a</p><p>b</p>");
  });

  test("self-closes void elements", () => {
    const br = html(jsx("br", {}));
    expect(br).toMatch(/^<br\s*\/>$/);
    expect(br).not.toContain("</br>");

    const img = html(jsx("img", { src: "/a.png", alt: "a" }));
    expect(img).toContain('src="/a.png"');
    expect(img).toMatch(/\/>$/);
    expect(img).not.toContain("</img>");

    const input = html(jsx("input", { type: "text" }));
    expect(input).not.toContain("</input>");
  });
});

describe("src/web/server", () => {
  const app = publicRoutes();
  test("GET /health returns ok as JSON", async () => {
    const response = await app.handle(new Request("http://localhost/health"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ ok: true });
  });

  test("GET / returns an HTML page with the app name and the stylesheet", async () => {
    const response = await app.handle(new Request("http://localhost/"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");

    const body = await response.text();
    expect(body).toContain("Commonplace");
    expect(body).toMatch(/<link[^>]+app\.css/);
    expect(body).toMatch(/rel="stylesheet"/);
  });

  test("an unknown route returns 404", async () => {
    const response = await app.handle(new Request("http://localhost/nope"));
    expect(response.status).toBe(404);
  });
});

describe("cp doctor", () => {
  const cli = join(repoRoot, "src", "cli", "main.ts");

  async function runCli(args: string[]) {
    const child = Bun.spawn({
      cmd: ["bun", "run", cli, ...args],
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

  test("reports the five milestone 0 checks", async () => {
    const { stdout } = await runCli([
      "doctor",
      "--json",
      "--config",
      validConfigPath,
    ]);

    const report = JSON.parse(stdout.trim()) as {
      ok: boolean;
      checks: { name: string; ok: boolean; detail: string }[];
    };

    expect(typeof report.ok).toBe("boolean");
    expect(Array.isArray(report.checks)).toBe(true);

    const names = report.checks.map((check) => check.name);
    // Later milestones add checks, so this file never asserts an exact list.
    for (const name of ["config", "db_root", "items_root", "browser_path", "single_file_cli"]) {
      expect(names).toContain(name);
    }

    for (const check of report.checks) {
      expect(typeof check.name).toBe("string");
      expect(typeof check.ok).toBe("boolean");
      expect(typeof check.detail).toBe("string");
    }
  }, 30_000);

  test("a missing single-file-cli fails the check instead of crashing", async () => {
    const { stdout, exitCode } = await runCli([
      "doctor",
      "--json",
      "--config",
      validConfigPath,
    ]);

    const report = JSON.parse(stdout.trim()) as {
      ok: boolean;
      checks: { name: string; ok: boolean }[];
    };
    const check = report.checks.find((entry) => entry.name === "single_file_cli");
    expect(check).toBeDefined();
    expect(report.ok).toBe(report.checks.every((entry) => entry.ok));
    expect(exitCode).toBe(report.ok ? 0 : 1);
  }, 30_000);

  test("an unknown subcommand exits 1 with CLI_UNKNOWN_COMMAND", async () => {
    const { stdout, stderr, exitCode } = await runCli(["nonsense"]);
    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain("CLI_UNKNOWN_COMMAND");
  }, 30_000);
});
