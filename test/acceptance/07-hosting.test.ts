// Acceptance test for milestone 7. It is the specification for that work.
// Change it only when the design changes, and say what changed and why.
//
// The milestone in one sentence
// -----------------------------
// Make the app hostable and make saving an article possible without a
// terminal: run the worker inside the server, add a save route the web form
// and an iOS Shortcut can both reach, add the settings page that mints the
// token a Shortcut needs, take the public origin from the config instead of
// the Host header, and ship a Dockerfile.
//
// What the implementer must create
// --------------------------------
// - `startWorker` in `src/services/worker.ts`, and a call to it in
//   `src/web/server.ts` so one process serves and drains.
// - `POST /items` in `src/web/routes/`, plus a one-field form on the library
//   page.
// - `/settings` with token create and revoke, in `src/web/routes/`.
// - `base_url` in `src/contracts/config.ts`, used to build the OIDC
//   `redirect_uri`.
// - `Dockerfile` and `.dockerignore` at the repo root.
//
// Files outside this one that must change
// ---------------------------------------
// - `test/acceptance/00-foundation.test.ts` owns the `parseConfig` contract.
//   Adding a required key changes it. Add `base_url` to its fixture and to
//   its required-key list, and say so in your report.
// - `test/acceptance/04-auth.test.ts` owns `UNGUARDED_ROUTES`. Nothing in
//   this milestone belongs on that list, so it must not grow.
// - `AGENTS.md` lists the commands. Add the Docker ones.
//
// Contract details this file pins down
// ------------------------------------
// - `POST /items` answers a session with a redirect and a token with JSON.
//   The two callers want different things, and `principal.via` already tells
//   them apart.
// - The route enqueues and returns. It never waits for the capture, because
//   a capture takes tens of seconds and a browser request must not.
// - A token acts as its owner, so a request saved with Bob's token belongs to
//   Bob whatever session cookie rides along with it.
// - The token secret is shown once, at creation, and never again.
//
// What this file cannot check
// ---------------------------
// It does not build the Docker image; that is far too slow for the gate. It
// reads the Dockerfile as text and checks the decisions that are easy to get
// wrong and expensive to discover in production.

import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addMs, now, toIso } from "../../src/contracts/clock";
import type { Config } from "../../src/contracts/config";
import { parseConfig } from "../../src/contracts/config";
import { AppError } from "../../src/contracts/errors";
import { asUserId, newRequestId } from "../../src/contracts/ids";
import type { UserId } from "../../src/contracts/ids";
import type { User } from "../../src/contracts/item";
import type { CaptureRequest, CaptureResult } from "../../src/services/acquire";
import { createApiToken, signPayload } from "../../src/services/auth";
import { startWorker } from "../../src/services/worker";
import { buildApp } from "../../src/web/server";
import { openDatabase } from "../../src/store/db";
import { listItems } from "../../src/store/items";
import { enqueueFetch, listFetchRequests } from "../../src/store/queue";
import { insertUser } from "../../src/store/users";

const repoRoot = join(import.meta.dir, "..", "..");

const ALICE = asUserId("11111111-1111-4111-8111-111111111111");
const BOB = asUserId("22222222-2222-4222-8222-222222222222");

const PAGE = `<!DOCTYPE html><html><head><title>Saved</title></head>
<body><article><h1>A saved article</h1>
<p>First paragraph with enough words that readability treats it as prose.</p>
<p>Second paragraph about looms and engines and the machines that read cards.</p>
<p>Third paragraph so the score is comfortably above the threshold it uses.</p>
</article></body></html>`;

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

function makeUser(id: UserId, subject: string): User {
  return {
    id,
    subject,
    email: `${subject}@example.com`,
    created_at: toIso(new Date("2026-01-01T00:00:00.000Z")),
  };
}

const SESSION_SECRET = "a-session-secret-long-enough-to-sign-with";

function sessionCookie(userId: UserId): string {
  const at = now();
  return `cp_session=${signPayload(SESSION_SECRET, {
    user_id: userId,
    iat: toIso(at),
    exp: toIso(addMs(at, 60_000)),
  })}`;
}

type Env = {
  db: Database;
  config: Config;
  itemsRoot: string;
  capture: (request: CaptureRequest) => Promise<CaptureResult>;
};

async function freshEnv(name: string): Promise<Env> {
  const root = await mkdtemp(join(tmpdir(), `commonplace-hosting-${name}-`));
  roots.push(root);

  const db = openDatabase(join(root, "db.sqlite"), now());
  insertUser(db, makeUser(ALICE, "alice"));
  insertUser(db, makeUser(BOB, "bob"));

  const itemsRoot = join(root, "items");
  const config: Config = {
    db_root: root,
    items_root: itemsRoot,
    base_url: "https://read.example.com",
    issuer_url: "https://id.example.com",
    client_id: "commonplace",
    client_secret: "secret",
    session_secret: SESSION_SECRET,
  };

  const capture = async (request: CaptureRequest): Promise<CaptureResult> => {
    await Bun.write(request.outputPath, PAGE);
    return { path: request.outputPath, bytes: PAGE.length };
  };

  return { db, config, itemsRoot, capture };
}

function post(
  app: ReturnType<typeof buildApp>,
  path: string,
  init: { body: BodyInit; headers: Record<string, string> },
): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      body: init.body,
      headers: init.headers,
    }),
  );
}

function form(fields: Record<string, string>): {
  body: string;
  headers: Record<string, string>;
} {
  return {
    body: new URLSearchParams(fields).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  };
}

describe("the config names the public origin", () => {
  const VALID = `db_root = "/var/lib/commonplace"
items_root = "/var/lib/commonplace/items"
base_url = "https://read.example.com"
issuer_url = "https://id.example.com"
client_id = "commonplace"
client_secret = "secret"
session_secret = "a-session-secret-long-enough-to-sign-with"
`;

  function caught(run: () => unknown): AppError {
    try {
      run();
    } catch (error) {
      if (error instanceof AppError) return error;
      throw error;
    }
    throw new AppError("CONFIG_PARSE_FAILED", "expected a throw");
  }

  test("parseConfig reads base_url", () => {
    expect(parseConfig(VALID).base_url).toBe("https://read.example.com");
  });

  test("base_url is required", () => {
    const without = VALID.split("\n")
      .filter((line) => !line.startsWith("base_url"))
      .join("\n");
    const error = caught(() => parseConfig(without));
    expect(error.code).toBe("CONFIG_MISSING_KEY");
    expect(error.context.key).toBe("base_url");
  });

  test("base_url must be an absolute http or https URL", () => {
    for (const bad of ["read.example.com", "ftp://read.example.com", "/read"]) {
      const error = caught(() =>
        parseConfig(VALID.replace("https://read.example.com", bad)),
      );
      expect(error.code).toBe("CONFIG_INVALID_VALUE");
      expect(error.context.key).toBe("base_url");
    }
  });

  // A trailing slash turns every joined path into a double slash, and an
  // OIDC redirect_uri must match the registered value byte for byte.
  test("base_url must not end with a slash", () => {
    const error = caught(() =>
      parseConfig(VALID.replace("https://read.example.com", "https://read.example.com/")),
    );
    expect(error.code).toBe("CONFIG_INVALID_VALUE");
    expect(error.context.key).toBe("base_url");
  });
});

describe("the login redirect comes from the config, not the Host header", () => {
  test("the authorization URL carries the base_url callback", async () => {
    const env = await freshEnv("redirect");
    const app = buildApp({ db: env.db, config: env.config, now });

    // The issuer is unreachable in a test, so discovery fails and the route
    // answers 503. What matters is that nothing in the redirect it would
    // build comes from the request. The implementer must expose the URL
    // builder so this assertion can read it without a network call.
    const { loginRedirectUri } = await import("../../src/web/routes/auth");
    expect(loginRedirectUri(env.config)).toBe(
      "https://read.example.com/login/callback",
    );

    const response = await app.handle(
      new Request("http://internal.local:3000/login", {
        headers: { host: "internal.local:3000" },
      }),
    );
    expect(response.status).toBe(503);
  });
});

describe("saving a URL from the web", () => {
  test("a form post enqueues a fetch and sends the reader back to the library", async () => {
    const env = await freshEnv("save-form");
    const app = buildApp({ db: env.db, config: env.config, now });

    const response = await post(app, "/items", {
      ...form({ url: "https://example.com/an-article" }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: sessionCookie(ALICE),
      },
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/library");

    const queued = listFetchRequests(env.db, ALICE, 10);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.url).toBe("https://example.com/an-article");
    expect(queued[0]!.state).toBe("queued");
  });

  test("the route returns before the capture runs", async () => {
    const env = await freshEnv("save-fast");
    const app = buildApp({ db: env.db, config: env.config, now });

    await post(app, "/items", {
      ...form({ url: "https://example.com/slow" }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: sessionCookie(ALICE),
      },
    });

    // Nothing captured it, so no item exists yet. The worker does that.
    expect(listItems(env.db, ALICE, 10)).toEqual([]);
  });

  test("a malformed URL is a bad request and enqueues nothing", async () => {
    const env = await freshEnv("save-bad");
    const app = buildApp({ db: env.db, config: env.config, now });

    const response = await post(app, "/items", {
      ...form({ url: "not a url" }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: sessionCookie(ALICE),
      },
    });

    expect(response.status).toBe(400);
    expect(listFetchRequests(env.db, ALICE, 10)).toEqual([]);
  });

  test("a signed-out post saves nothing", async () => {
    const env = await freshEnv("save-signed-out");
    const app = buildApp({ db: env.db, config: env.config, now });

    const response = await post(app, "/items", {
      ...form({ url: "https://example.com/x" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });

    expect([303, 401]).toContain(response.status);
    expect(listFetchRequests(env.db, ALICE, 10)).toEqual([]);
    expect(listFetchRequests(env.db, BOB, 10)).toEqual([]);
  });

  test("the library page carries the save form", async () => {
    const env = await freshEnv("save-form-visible");
    const app = buildApp({ db: env.db, config: env.config, now });

    const response = await app.handle(
      new Request("http://localhost/library", {
        headers: { cookie: sessionCookie(ALICE) },
      }),
    );
    const body = await response.text();

    expect(body).toContain('action="/items"');
    expect(body).toContain('method="post"');
    expect(body).toContain('name="url"');
  });
});

describe("saving a URL with an API token", () => {
  test("a bearer token enqueues and answers JSON", async () => {
    const env = await freshEnv("token-save");
    const app = buildApp({ db: env.db, config: env.config, now });
    const { secret } = createApiToken(env.db, ALICE, "shortcut", now());

    const response = await post(app, "/items", {
      body: JSON.stringify({ url: "https://example.com/from-a-phone" }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`,
      },
    });

    expect(response.status).toBe(201);
    const payload = (await response.json()) as {
      request_id: string;
      state: string;
    };
    expect(payload.state).toBe("queued");
    expect(payload.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(listFetchRequests(env.db, ALICE, 10)).toHaveLength(1);
  });

  // A token acts as its owner. A cookie riding along with it must not move
  // the row into the cookie holder's library.
  test("the token's owner owns the request, whatever cookie rides along", async () => {
    const env = await freshEnv("token-owner");
    const app = buildApp({ db: env.db, config: env.config, now });
    const { secret } = createApiToken(env.db, BOB, "bob's phone", now());

    await post(app, "/items", {
      body: JSON.stringify({ url: "https://example.com/bobs" }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`,
        cookie: sessionCookie(ALICE),
      },
    });

    expect(listFetchRequests(env.db, BOB, 10)).toHaveLength(1);
    expect(listFetchRequests(env.db, ALICE, 10)).toEqual([]);
  });

  test("a rejected token saves nothing", async () => {
    const env = await freshEnv("token-bad");
    const app = buildApp({ db: env.db, config: env.config, now });

    const response = await post(app, "/items", {
      body: JSON.stringify({ url: "https://example.com/x" }),
      headers: {
        "content-type": "application/json",
        authorization: "Bearer not-a-real-token",
      },
    });

    expect([303, 401]).toContain(response.status);
    expect(listFetchRequests(env.db, ALICE, 10)).toEqual([]);
  });
});

describe("the settings page mints the token", () => {
  test("creating a token shows the secret exactly once", async () => {
    const env = await freshEnv("token-create");
    const app = buildApp({ db: env.db, config: env.config, now });

    const created = await post(app, "/settings/tokens", {
      ...form({ name: "iOS Shortcut" }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: sessionCookie(ALICE),
      },
    });
    expect(created.status).toBe(200);

    const shown = await created.text();
    const secret = shown.match(/[A-Za-z0-9_-]{32,}/g) ?? [];
    expect(secret.length).toBeGreaterThan(0);

    // The list page names the token but never shows the secret again.
    const listed = await app.handle(
      new Request("http://localhost/settings", {
        headers: { cookie: sessionCookie(ALICE) },
      }),
    );
    const body = await listed.text();
    expect(body).toContain("iOS Shortcut");
    for (const candidate of secret) {
      if (candidate.length >= 32) expect(body).not.toContain(candidate);
    }
  });

  test("a token is revoked from the settings page", async () => {
    const env = await freshEnv("token-revoke");
    const app = buildApp({ db: env.db, config: env.config, now });
    const { token } = createApiToken(env.db, ALICE, "old phone", now());

    const response = await post(app, `/settings/tokens/${token.id}/delete`, {
      body: "",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: sessionCookie(ALICE),
      },
    });

    expect(response.status).toBe(303);
    const listed = await app.handle(
      new Request("http://localhost/settings", {
        headers: { cookie: sessionCookie(ALICE) },
      }),
    );
    expect(await listed.text()).not.toContain("old phone");
  });

  test("one reader cannot revoke another reader's token", async () => {
    const env = await freshEnv("token-tenant");
    const app = buildApp({ db: env.db, config: env.config, now });
    const { token } = createApiToken(env.db, BOB, "bob token", now());

    await post(app, `/settings/tokens/${token.id}/delete`, {
      body: "",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: sessionCookie(ALICE),
      },
    });

    const listed = await app.handle(
      new Request("http://localhost/settings", {
        headers: { cookie: sessionCookie(BOB) },
      }),
    );
    expect(await listed.text()).toContain("bob token");
  });

  test("the settings page needs a signed-in reader", async () => {
    const env = await freshEnv("settings-guard");
    const app = buildApp({ db: env.db, config: env.config, now });

    const response = await app.handle(
      new Request("http://localhost/settings"),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login");
  });
});

describe("the worker runs inside the server process", () => {
  test("startWorker drains a queued request and stops cleanly", async () => {
    const env = await freshEnv("worker-drain");
    enqueueFetch(env.db, {
      id: newRequestId(),
      item_id: null,
      url: "https://example.com/queued",
      source_path: null,
      state: "queued",
      lease_expires_at: null,
      attempts: 0,
      error_code: null,
      created_at: toIso(now()),
      user_id: ALICE,
    });

    const worker = startWorker({
      db: env.db,
      itemsRoot: env.itemsRoot,
      now,
      capture: env.capture,
    });

    const deadline = Date.now() + 15_000;
    while (listItems(env.db, ALICE, 10).length === 0 && Date.now() < deadline) {
      await Bun.sleep(50);
    }
    await worker.stop();

    const items = listItems(env.db, ALICE, 10);
    expect(items).toHaveLength(1);
    expect(items[0]!.url).toBe("https://example.com/queued");
  }, 30_000);

  // stop() must resolve only after the loop has left, so a shutdown never
  // kills a capture between writing a file and committing its row.
  test("stop resolves after the loop has left", async () => {
    const env = await freshEnv("worker-stop");
    const worker = startWorker({
      db: env.db,
      itemsRoot: env.itemsRoot,
      now,
      capture: env.capture,
    });

    await worker.stop();
    expect(worker.running()).toBe(false);
    await worker.stop();
  }, 30_000);

  test("the server starts the worker when it runs as the entry point", async () => {
    const source = await readFile(join(repoRoot, "src", "web", "server.ts"), "utf8");
    expect(source).toContain("startWorker");
    expect(source).toContain("import.meta.main");
  });
});

describe("the Dockerfile", () => {
  async function dockerfile(): Promise<string> {
    return readFile(join(repoRoot, "Dockerfile"), "utf8");
  }

  test("it pins a Bun version rather than tracking latest", async () => {
    const text = await dockerfile();
    expect(text).toMatch(/FROM\s+oven\/bun:\d+\.\d+\.\d+/);
    expect(text).not.toMatch(/FROM\s+oven\/bun:latest/);
  });

  // single-file-cli spawns a browser. Without one in the image, every
  // capture fails at runtime with ACQUIRE_TOOL_MISSING.
  test("it installs a browser and points the config at it", async () => {
    const text = await dockerfile();
    expect(text.toLowerCase()).toMatch(/chromium|chrome/);
    expect(text).toContain("PUPPETEER_SKIP_DOWNLOAD");
  });

  test("it runs the web server, not the CLI", async () => {
    const text = await dockerfile();
    expect(text).toMatch(/CMD.*src\/web\/server\.ts/);
  });

  test("it declares the port and a health check that uses /health", async () => {
    const text = await dockerfile();
    expect(text).toMatch(/EXPOSE\s+3000/);
    expect(text).toContain("/health");
  });

  // The roots hold the database and every captured file. Losing them on a
  // redeploy loses the archive, which is the whole point of the app.
  test("it declares the data roots as volumes", async () => {
    const text = await dockerfile();
    expect(text).toMatch(/VOLUME/);
  });

  test("it does not run as root", async () => {
    const text = await dockerfile();
    expect(text).toMatch(/USER\s+(?!root)\w+/);
  });

  test("the dockerignore keeps the build context small and secret-free", async () => {
    const text = await readFile(join(repoRoot, ".dockerignore"), "utf8");
    const lines = text.split("\n").map((line) => line.trim());
    for (const entry of ["node_modules", ".git"]) {
      expect(lines).toContain(entry);
    }
  });
});
