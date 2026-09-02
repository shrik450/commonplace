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
// Why `bun run verify` is not tested end to end
// ---------------------------------------------
// `verify` runs `bun test`, which runs this file. Running it here would
// recurse. So this file tests the pure parts of `scripts/verify.ts` directly.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  buildSummary,
  parseBunTestOutput,
  parseOxlintOutput,
  parseTscOutput,
} from "../../scripts/verify";
import { AppError, isAppError, toLogLine } from "../../src/contracts/errors";
import { parseConfig } from "../../src/contracts/config";
import { defaultConfigPath, loadConfig } from "../../src/store/config";
import { Fragment, jsx, jsxs, raw } from "../../src/web/views/jsx-runtime";
import { app } from "../../src/web/server";

const repoRoot = join(import.meta.dir, "..", "..");
const fixtureDir = join(repoRoot, "test", "fixtures", "config");
const validConfigPath = join(fixtureDir, "valid.toml");

const validConfigText = `
db_root = "/tmp/commonplace-test/db"
items_root = "/tmp/commonplace-test/items"
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

describe("scripts/verify buildSummary", () => {
  const clean = {
    typecheck: { errors: 0 },
    lint: { errors: 0 },
    test: { pass: 41, fail: 0, failures: [] },
  };

  test("reports ok when every part is clean", () => {
    expect(buildSummary(clean)).toEqual({ ok: true, ...clean });
  });

  test("reports not ok when the type checker found errors", () => {
    const summary = buildSummary({ ...clean, typecheck: { errors: 2 } });
    expect(summary.ok).toBe(false);
    expect(summary.typecheck.errors).toBe(2);
  });

  test("reports not ok when the linter found errors", () => {
    expect(buildSummary({ ...clean, lint: { errors: 1 } }).ok).toBe(false);
  });

  test("reports not ok when a test failed", () => {
    const summary = buildSummary({
      ...clean,
      test: { pass: 40, fail: 1, failures: ["core/walk > collapses whitespace"] },
    });
    expect(summary.ok).toBe(false);
    expect(summary.test.failures).toEqual(["core/walk > collapses whitespace"]);
  });

  test("prints as one JSON line with the documented shape", () => {
    const line = JSON.stringify(buildSummary(clean));
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({
      ok: true,
      typecheck: { errors: 0 },
      lint: { errors: 0 },
      test: { pass: 41, fail: 0, failures: [] },
    });
  });
});

describe("scripts/verify parseTscOutput", () => {
  test("counts zero errors for a clean run", () => {
    expect(parseTscOutput("")).toEqual({ errors: 0 });
    expect(parseTscOutput("\n")).toEqual({ errors: 0 });
  });

  test("counts one error", () => {
    const output = [
      "src/cli/main.ts(12,3): error TS2554: Expected 1 arguments, but got 0.",
      "",
      "Found 1 error in src/cli/main.ts:12",
      "",
    ].join("\n");
    expect(parseTscOutput(output)).toEqual({ errors: 1 });
  });

  test("counts errors across several files", () => {
    const output = [
      "src/core/walk.ts(88,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/core/walk.ts(91,5): error TS2532: Object is possibly 'undefined'.",
      "src/web/server.ts(12,3): error TS2554: Expected 1 arguments, but got 0.",
      "",
      "Found 3 errors in 2 files.",
      "",
      "Errors  Files",
      "     2  src/core/walk.ts:88",
      "     1  src/web/server.ts:12",
      "",
    ].join("\n");
    expect(parseTscOutput(output)).toEqual({ errors: 3 });
  });
});

describe("scripts/verify parseOxlintOutput", () => {
  test("counts zero errors for a clean run", () => {
    const output = [
      "Found 0 warnings and 0 errors.",
      "Finished in 21ms on 42 files with 96 rules using 8 threads.",
      "",
    ].join("\n");
    expect(parseOxlintOutput(output)).toEqual({ errors: 0 });
  });

  test("ignores warnings", () => {
    const output = [
      "  ! eslint(no-unused-vars): Variable 'x' is declared but never used.",
      "   ,-[src/cli/main.ts:4:7]",
      " 4 | const x = 1;",
      "   `----",
      "",
      "Found 3 warnings and 0 errors.",
      "Finished in 24ms on 42 files with 96 rules using 8 threads.",
      "",
    ].join("\n");
    expect(parseOxlintOutput(output)).toEqual({ errors: 0 });
  });

  test("counts errors from a failing run", () => {
    const output = [
      "  x eslint(no-debugger): `debugger` statement is not allowed.",
      "   ,-[src/web/server.ts:9:3]",
      " 9 |   debugger;",
      "   :   ^^^^^^^^^",
      "   `----",
      "  help: Remove this statement.",
      "",
      "  x eslint(no-dupe-keys): Duplicate key 'ok'.",
      "   ,-[src/cli/main.ts:20:5]",
      "20 |     ok: true,",
      "   `----",
      "",
      "Found 1 warning and 2 errors.",
      "Finished in 30ms on 42 files with 96 rules using 8 threads.",
      "",
    ].join("\n");
    expect(parseOxlintOutput(output)).toEqual({ errors: 2 });
  });
});

describe("scripts/verify parseBunTestOutput", () => {
  test("counts a clean run", () => {
    const output = [
      "bun test v1.4.0",
      "",
      "test/unit/config.test.ts:",
      "(pass) parseConfig > accepts a full config [1.20ms]",
      "(pass) parseConfig > rejects a relative db_root [0.41ms]",
      "",
      " 2 pass",
      " 0 fail",
      "Ran 2 tests across 1 files. [45.00ms]",
      "",
    ].join("\n");
    expect(parseBunTestOutput(output)).toEqual({
      pass: 2,
      fail: 0,
      failures: [],
    });
  });

  test("counts a failing run and names the failing tests", () => {
    const output = [
      "bun test v1.4.0",
      "",
      "test/unit/config.test.ts:",
      "(pass) parseConfig > accepts a full config [1.20ms]",
      "(fail) parseConfig > rejects a relative db_root [0.90ms]",
      "",
      "error: expect(received).toBe(expected)",
      "",
      "Expected: 1",
      "Received: 0",
      "",
      "      at <anonymous> (test/unit/config.test.ts:31:5)",
      "",
      "test/unit/walk.test.ts:",
      "(pass) walk > keeps offsets contiguous [2.10ms]",
      "(fail) walk > collapses whitespace [3.00ms]",
      "",
      " 2 pass",
      " 2 fail",
      "Ran 4 tests across 2 files. [98.00ms]",
      "",
    ].join("\n");

    const result = parseBunTestOutput(output);
    expect(result.pass).toBe(2);
    expect(result.fail).toBe(2);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]).toContain("parseConfig > rejects a relative db_root");
    expect(result.failures[1]).toContain("walk > collapses whitespace");
  });

  test("keeps failure names free of markers and timings", () => {
    const output = [
      "(fail) walk > collapses whitespace [3.00ms]",
      " 0 pass",
      " 1 fail",
      "Ran 1 tests across 1 files. [10.00ms]",
      "",
    ].join("\n");

    const name = parseBunTestOutput(output).failures[0] ?? "";
    expect(name).not.toContain("(fail)");
    expect(name).not.toContain("ms]");
    expect(name.trim()).toBe(name);
  });
});

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
      issuer_url: "https://issuer.example.com",
      client_id: "commonplace-test",
      client_secret: "test-client-secret",
      session_secret: "0123456789abcdef0123456789abcdef",
      browser_path: "/usr/bin/chromium",
    });
  });

  test("accepts a config without the optional browser_path", () => {
    const config = parseConfig(configWithout("browser_path"));
    expect(config.browser_path).toBeUndefined();
    expect(config.db_root).toBe("/tmp/commonplace-test/db");
  });

  test("throws CONFIG_PARSE_FAILED for invalid TOML", () => {
    const error = caught(() => parseConfig('db_root = "/tmp/db\nitems_root ='));
    expect(isAppError(error)).toBe(true);
    expect((error as AppError).code).toBe("CONFIG_PARSE_FAILED");
  });

  const requiredKeys = [
    "db_root",
    "items_root",
    "issuer_url",
    "client_id",
    "client_secret",
    "session_secret",
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
