import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addMs, now, toIso } from "../../src/contracts/clock";
import { AppError } from "../../src/contracts/errors";
import type { Config } from "../../src/contracts/config";
import { parseConfig } from "../../src/contracts/config";
import {
  asUserId,
  newItemId,
  newRequestId,
} from "../../src/contracts/ids";
import {
  isJsonObject,
  isStringValue,
  parseJsonValue,
} from "../../src/contracts/item";
import type { FetchRequest, Item, User } from "../../src/contracts/item";
import type { CaptureRequest, CaptureResult } from "../../src/services/acquire";
import { authenticate, createApiToken, signPayload } from "../../src/services/auth";
import { startWorker } from "../../src/services/worker";
import { openDatabase } from "../../src/store/db";
import { insertItem, listItems } from "../../src/store/items";
import {
  claimNext,
  claimRequest,
  completeFetch,
  enqueueFetch,
  failFetch,
  releaseFetch,
} from "../../src/store/queue";
import { insertUser, listApiTokens } from "../../src/store/users";
import { buildApp } from "../../src/web/server";
import { loginRedirectUri } from "../../src/web/routes/auth";

const ALICE = asUserId("11111111-1111-4111-8111-111111111111");
const BOB = asUserId("22222222-2222-4222-8222-222222222222");
const SECRET = "x".repeat(32);
const PAGE = "<html><body><article><h1>Saved</h1><p>Enough text to create a searchable saved item.</p></article></body></html>";
const repoRoot = join(import.meta.dir, "..", "..");
const roots: string[] = [];

const config: Config = parseConfig([
  'db_root = "/tmp/commonplace/db"',
  'items_root = "/tmp/commonplace/items"',
  'base_url = "https://read.example.com"',
  'issuer_url = "https://id.example.com"',
  'client_id = "client"',
  'client_secret = "secret"',
  `session_secret = "${SECRET}"`,
  'browser_path = "/usr/bin/chromium"',
].join("\n"));

type Env = { db: Database; itemsRoot: string; capture: (request: CaptureRequest) => Promise<CaptureResult> };

function user(id: typeof ALICE, subject: string): User {
  return { id, subject, email: null, created_at: "2026-01-01T00:00:00.000Z" };
}

async function environment(name: string): Promise<Env> {
  const root = await mkdtemp(join(tmpdir(), `commonplace-hosting-${name}-`));
  roots.push(root);
  const db = openDatabase(join(root, "db.sqlite"), now());
  insertUser(db, user(ALICE, "alice"));
  insertUser(db, user(BOB, "bob"));
  const itemsRoot = join(root, "items");
  await mkdir(itemsRoot, { recursive: true });
  return {
    db,
    itemsRoot,
    capture: async (request) => {
      await Bun.write(request.outputPath, PAGE);
      return { path: request.outputPath, bytes: PAGE.length };
    },
  };
}

function session(userId: typeof ALICE): string {
  return `cp_session=${signPayload(SECRET, { user_id: userId, exp: addMs(now(), 60_000).toISOString() })}`;
}

function queuedCount(db: Database, userId: typeof ALICE): number {
  return db.query<{ count: number }, [string]>(
    "SELECT COUNT(*) AS count FROM fetch_requests WHERE user_id = ?",
  ).get(userId)!.count;
}

function post(app: ReturnType<typeof buildApp>, path: string, body: BodyInit, headers: Record<string, string>): Promise<Response> {
  return app.handle(new Request(`http://localhost${path}`, { method: "POST", body, headers }));
}

function form(value: string) {
  return { body: new URLSearchParams({ url: value }).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } };
}

function queuedRequest(userId: typeof ALICE, url: string, createdAt = toIso(now())): FetchRequest {
  return {
    id: newRequestId(),
    user_id: userId,
    item_id: null,
    url,
    state: "queued",
    lease_expires_at: null,
    attempts: 0,
    error_code: null,
    created_at: createdAt,
  };
}

function savedItem(userId: typeof ALICE, url: string): Item {
  return {
    id: newItemId(),
    user_id: userId,
    url,
    title: "Saved page",
    author: null,
    created_at: toIso(now()),
    ingested_at: toIso(now()),
  };
}

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

describe("host configuration", () => {
  test("uses the configured public origin for login callbacks", () => {
    expect(loginRedirectUri(config)).toBe("https://read.example.com/login/callback");
  });
});

describe("save endpoint", () => {
  test("a signed-in form redirects to durable save status", async () => {
    const env = await environment("form");
    const app = buildApp({ db: env.db, config: { ...config, items_root: env.itemsRoot }, now });
    const input = form("https://example.com/article");
    const response = await post(app, "/items", input.body, { ...input.headers, cookie: session(ALICE) });
    expect(response.status).toBe(303);
    const location = response.headers.get("location");
    expect(location).toMatch(/^\/saves\/[0-9a-f-]+$/);
    expect(queuedCount(env.db, ALICE)).toBe(1);

    const status = await app.handle(
      new Request(`http://localhost${location}`, {
        headers: { cookie: session(ALICE) },
      }),
    );
    expect(status.status).toBe(200);
    const body = await status.text();
    expect(body).toContain("Waiting to save…");
    expect(body).toContain("https://example.com/article");
    expect(body).toContain('http-equiv="refresh" content="2"');
  });

  test("an API token returns JSON and owns the queued request", async () => {
    const env = await environment("api");
    const app = buildApp({ db: env.db, config: { ...config, items_root: env.itemsRoot }, now });
    const { secret } = createApiToken(env.db, BOB, "phone", now());
    const response = await post(app, "/items", JSON.stringify({ url: "https://example.com/phone" }), {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
      cookie: session(ALICE),
    });
    expect(response.status).toBe(201);
    const payload = parseJsonValue(await response.text());
    if (
      !isJsonObject(payload) ||
      !isStringValue(payload.request_id) ||
      !isStringValue(payload.state) ||
      !isStringValue(payload.status_url)
    ) {
      throw new AppError("VIEW_MISSING_FIELD", "save response did not contain status details");
    }
    expect(payload.state).toBe("queued");
    expect(payload.status_url).toBe(
      `${config.base_url}/saves/${payload.request_id}`,
    );
    expect(queuedCount(env.db, BOB)).toBe(1);
    expect(queuedCount(env.db, ALICE)).toBe(0);
  });

  test("an API token returns JSON for every save state", async () => {
    const env = await environment("save-api-states");
    const app = buildApp({ db: env.db, config: { ...config, items_root: env.itemsRoot }, now });
    const { secret } = createApiToken(env.db, ALICE, "automation", now());

    const queued = enqueueFetch(
      env.db,
      queuedRequest(ALICE, "https://example.com/api-queued"),
    );
    const claimedRequest = enqueueFetch(
      env.db,
      queuedRequest(ALICE, "https://example.com/api-claimed"),
    );
    claimRequest(env.db, claimedRequest.id, now(), 60_000);
    const retryRequest = enqueueFetch(
      env.db,
      queuedRequest(ALICE, "https://example.com/api-retry"),
    );
    const retryClaim = claimRequest(env.db, retryRequest.id, now(), 60_000)!;
    expect(releaseFetch(env.db, retryClaim.id, retryClaim.attempts, "ACQUIRE_TIMEOUT")).toBe(true);
    const failedRequest = enqueueFetch(
      env.db,
      queuedRequest(ALICE, "https://example.com/api-failed"),
    );
    const failedClaim = claimRequest(env.db, failedRequest.id, now(), 60_000)!;
    expect(failFetch(env.db, failedClaim.id, failedClaim.attempts, "ACQUIRE_FAILED")).toBe(true);
    const item = savedItem(ALICE, "https://example.com/api-done");
    insertItem(env.db, item);
    const doneRequest = enqueueFetch(env.db, queuedRequest(ALICE, item.url));
    const doneClaim = claimRequest(env.db, doneRequest.id, now(), 60_000)!;
    expect(completeFetch(env.db, doneClaim.id, doneClaim.attempts, item.id)).toBe(true);

    const expected = [
      { request: queued, state: "queued", attempts: 0, error_code: null, item_id: null },
      { request: claimedRequest, state: "claimed", attempts: 1, error_code: null, item_id: null },
      { request: retryRequest, state: "queued", attempts: 1, error_code: "ACQUIRE_TIMEOUT", item_id: null },
      { request: failedRequest, state: "failed", attempts: 1, error_code: "ACQUIRE_FAILED", item_id: null },
      { request: doneRequest, state: "done", attempts: 1, error_code: null, item_id: item.id },
    ] as const;

    for (const expectedState of expected) {
      const response = await app.handle(new Request(
        `http://localhost/saves/${expectedState.request.id}`,
        { headers: { authorization: `Bearer ${secret}`, cookie: session(BOB) } },
      ));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("location")).toBeNull();
      const body = await response.text();
      expect(body).not.toContain("<html>");
      const payload = parseJsonValue(body);
      if (!isJsonObject(payload)) {
        throw new AppError("VIEW_MISSING_FIELD", "save status was not a JSON object");
      }
      expect(payload).toMatchObject({
        request_id: expectedState.request.id,
        state: expectedState.state,
        attempts: expectedState.attempts,
        error_code: expectedState.error_code,
        item_id: expectedState.item_id,
      });
    }
  });

  test("renders queued, claimed, retried, failed, and done save states", async () => {
    const env = await environment("save-states");
    const app = buildApp({ db: env.db, config: { ...config, items_root: env.itemsRoot }, now });

    const claimedRequest = enqueueFetch(
      env.db,
      queuedRequest(ALICE, "https://example.com/claimed"),
    );
    const claimed = claimNext(env.db, now(), 60_000)!;
    expect(claimed.id).toBe(claimedRequest.id);
    const claimedPage = await app.handle(new Request(
      `http://localhost/saves/${claimed.id}`,
      { headers: { cookie: session(ALICE) } },
    ));
    expect(claimedPage.status).toBe(200);
    const claimedBody = await claimedPage.text();
    expect(claimedBody).toContain("Saving a local copy…");
    expect(claimedBody).toContain("Attempt 1 of 3.");
    expect(claimedBody).toContain('http-equiv="refresh" content="2"');

    const retryRequest = enqueueFetch(
      env.db,
      queuedRequest(ALICE, "https://example.com/retry"),
    );
    const retryClaim = claimRequest(env.db, retryRequest.id, now(), 60_000)!;
    expect(releaseFetch(env.db, retryClaim.id, retryClaim.attempts, "ACQUIRE_TIMEOUT")).toBe(true);
    const retryPage = await app.handle(new Request(
      `http://localhost/saves/${retryRequest.id}`,
      { headers: { cookie: session(ALICE) } },
    ));
    const retryBody = await retryPage.text();
    expect(retryBody).toContain("Waiting to save…");
    expect(retryBody).toContain("Attempt 2 of 3 will start next.");
    expect(retryBody).toContain("Error code: ACQUIRE_TIMEOUT");
    expect(retryBody).not.toContain("aria-live");

    const failedRequest = enqueueFetch(
      env.db,
      queuedRequest(ALICE, "https://example.com/failed"),
    );
    const failedClaim = claimRequest(env.db, failedRequest.id, now(), 60_000)!;
    expect(failFetch(env.db, failedClaim.id, failedClaim.attempts, "ACQUIRE_FAILED")).toBe(true);
    const failedPage = await app.handle(new Request(
      `http://localhost/saves/${failedRequest.id}`,
      { headers: { cookie: session(ALICE) } },
    ));
    const failedBody = await failedPage.text();
    expect(failedBody).toContain("Save failed");
    expect(failedBody).toContain("return to your library and submit it again");
    expect(failedBody).toContain("Error code: ACQUIRE_FAILED");
    expect(failedBody).not.toContain('http-equiv="refresh"');

    const item = savedItem(ALICE, "https://example.com/done");
    insertItem(env.db, item);
    const doneRequest = enqueueFetch(
      env.db,
      queuedRequest(ALICE, item.url),
    );
    const doneClaim = claimRequest(env.db, doneRequest.id, now(), 60_000)!;
    expect(completeFetch(env.db, doneClaim.id, doneClaim.attempts, item.id)).toBe(true);
    const donePage = await app.handle(new Request(
      `http://localhost/saves/${doneRequest.id}`,
      { headers: { cookie: session(ALICE) } },
    ));
    expect(donePage.status).toBe(303);
    expect(donePage.headers.get("location")).toBe(`/items/${item.id}`);
  });

  test("isolates save status by tenant and validates request IDs", async () => {
    const env = await environment("save-tenant");
    const app = buildApp({ db: env.db, config: { ...config, items_root: env.itemsRoot }, now });
    const { secret: bobSecret } = createApiToken(env.db, BOB, "bob-phone", now());
    const aliceRequest = enqueueFetch(
      env.db,
      queuedRequest(ALICE, "https://example.com/alice"),
    );
    const bobRequest = enqueueFetch(
      env.db,
      queuedRequest(BOB, "https://example.com/bob"),
    );

    const hidden = await app.handle(new Request(
      `http://localhost/saves/${bobRequest.id}`,
      { headers: { cookie: session(ALICE) } },
    ));
    expect(hidden.status).toBe(404);

    const apiHidden = await app.handle(new Request(
      `http://localhost/saves/${aliceRequest.id}`,
      { headers: { authorization: `Bearer ${bobSecret}` } },
    ));
    expect(apiHidden.status).toBe(404);
    expect(apiHidden.headers.get("content-type")).toBe("application/json");
    expect(await apiHidden.text()).toBe('{"error":"STORE_NOT_FOUND"}');

    const invalidBearer = await app.handle(new Request(
      `http://localhost/saves/${bobRequest.id}`,
      { headers: { authorization: "Bearer invalid", cookie: session(ALICE) } },
    ));
    expect(invalidBearer.status).toBe(401);
    expect(invalidBearer.headers.get("content-type")).toBe("application/json");
    expect(await invalidBearer.text()).toBe('{"error":"AUTH_TOKEN_INVALID"}');

    const invalid = await app.handle(new Request(
      "http://localhost/saves/not-a-request-id",
      { headers: { cookie: session(ALICE) } },
    ));
    expect(invalid.status).toBe(400);
  });

  test("shows at most ten active or failed saves in the tenant library", async () => {
    const env = await environment("save-library");
    const app = buildApp({ db: env.db, config: { ...config, items_root: env.itemsRoot }, now });
    insertItem(env.db, savedItem(ALICE, "https://example.com/saved-page"));
    for (let index = 0; index < 11; index += 1) {
      const request = enqueueFetch(
        env.db,
        queuedRequest(
          ALICE,
          `https://example.com/alice-${index}`,
          new Date(1_700_000_000_000 + index * 1_000).toISOString(),
        ),
      );
      if (index === 10) {
        const claimed = claimRequest(env.db, request.id, now(), 60_000)!;
        expect(failFetch(env.db, claimed.id, claimed.attempts, "ACQUIRE_FAILED")).toBe(true);
      }
    }
    enqueueFetch(env.db, queuedRequest(BOB, "https://example.com/bob"));

    const library = await app.handle(new Request("http://localhost/library", {
      headers: { cookie: session(ALICE) },
    }));
    expect(library.status).toBe(200);
    const body = await library.text();
    expect(body.match(/\/saves\//g)).toHaveLength(10);
    expect(body).toContain("Save activity");
    expect(body).toContain("Saved pages");
    expect(body).toContain("https://example.com/alice-10");
    expect(body).not.toContain("https://example.com/alice-0");
    expect(body).not.toContain("https://example.com/bob");
  });

  test("rejects bad or unauthenticated saves", async () => {
    const env = await environment("bad-save");
    const app = buildApp({ db: env.db, config: { ...config, items_root: env.itemsRoot }, now });
    const bad = form("not a URL");
    expect((await post(app, "/items", bad.body, { ...bad.headers, cookie: session(ALICE) })).status).toBe(400);
    expect((await post(app, "/items", bad.body, bad.headers)).status).toBe(303);
    expect(queuedCount(env.db, ALICE)).toBe(0);
  });
});

describe("token management", () => {
  test("shows a token secret once and lets only its owner revoke it", async () => {
    const env = await environment("tokens");
    const app = buildApp({ db: env.db, config: { ...config, items_root: env.itemsRoot }, now });
    const created = await post(app, "/settings/tokens", new URLSearchParams({ name: "phone" }).toString(), {
      "content-type": "application/x-www-form-urlencoded",
      cookie: session(ALICE),
    });
    expect(created.status).toBe(200);
    const shown = await created.text();
    const secret = shown.match(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g)?.[0];
    expect(secret).toBeDefined();
    expect(shown).toContain("phone");

    const token = listApiTokens(env.db, ALICE)[0]!;
    const digest = new Bun.CryptoHasher("sha256").update(secret!).digest("hex");
    expect(token.token_hash).toBe(digest);
    expect(token.token_hash).not.toBe(secret);

    const settings = await app.handle(new Request("http://localhost/settings", { headers: { cookie: session(ALICE) } }));
    const settingsBody = await settings.text();
    expect(settingsBody).toContain("phone");
    expect(settingsBody).not.toContain(secret!);

    const confirmation = await app.handle(new Request(`http://localhost/settings/tokens/${token.id}/revoke`, { headers: { cookie: session(ALICE) } }));
    expect(confirmation.status).toBe(200);
    expect(await confirmation.text()).toContain(`/settings/tokens/${token.id}/delete`);
    const revoked = await post(app, `/settings/tokens/${token.id}/delete`, "", {
      "content-type": "application/x-www-form-urlencoded",
      cookie: session(ALICE),
    });
    expect(revoked.status).toBe(303);
    await expect(authenticate(new Request("https://read.example.com", { headers: { authorization: `Bearer ${secret}` } }), { db: env.db, config, now: now() })).rejects.toMatchObject({ code: "AUTH_TOKEN_INVALID" });
  });

  test("a reader cannot confirm or revoke another reader's token", async () => {
    const env = await environment("tokens-tenant");
    const app = buildApp({ db: env.db, config: { ...config, items_root: env.itemsRoot }, now });
    const { token, secret } = createApiToken(env.db, BOB, "bob-phone", now());
    const unauthenticatedCreate = await post(app, "/settings/tokens", new URLSearchParams({ name: "nope" }).toString(), {
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(unauthenticatedCreate.status).toBe(303);
    const unauthenticatedDelete = await post(app, `/settings/tokens/${token.id}/delete`, "", {
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(unauthenticatedDelete.status).toBe(303);
    const confirmation = await app.handle(new Request(`http://localhost/settings/tokens/${token.id}/revoke`, { headers: { cookie: session(ALICE) } }));
    expect(confirmation.status).toBe(400);
    const deleted = await post(app, `/settings/tokens/${token.id}/delete`, "", {
      "content-type": "application/x-www-form-urlencoded",
      cookie: session(ALICE),
    });
    expect(deleted.status).toBe(303);
    await expect(authenticate(new Request("https://read.example.com", { headers: { authorization: `Bearer ${secret}` } }), { db: env.db, config, now: now() })).resolves.toMatchObject({ user: { id: BOB } });
  });

  test("settings persist through HTTP, stay tenant-scoped, and render each theme", async () => {
    const env = await environment("settings-http");
    const app = buildApp({ db: env.db, config: { ...config, items_root: env.itemsRoot }, now });
    const values = {
      theme: "dark",
      font: "sans",
      text_size: "large",
      line_spacing: "loose",
      paragraph_spacing: "compact",
      text_width: "wide",
    };
    const body = new URLSearchParams(values).toString();
    const saved = await post(app, "/settings", body, {
      "content-type": "application/x-www-form-urlencoded",
      cookie: session(ALICE),
    });
    expect(saved.status).toBe(303);
    expect(env.db.query("SELECT theme, font, text_size FROM user_settings WHERE user_id = ?").get(ALICE)).toMatchObject({ theme: "dark", font: "sans", text_size: "large" });

    const invalid = await post(app, "/settings", new URLSearchParams({ ...values, theme: "blue" }).toString(), {
      "content-type": "application/x-www-form-urlencoded",
      cookie: session(ALICE),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toContain("VIEW_INVALID_VALUE");

    const bobPage = await app.handle(new Request("http://localhost/settings", { headers: { cookie: session(BOB) } }));
    expect(await bobPage.text()).toContain('<option value="auto" selected>Auto</option>');
    const darkPage = await app.handle(new Request("http://localhost/settings", { headers: { cookie: session(ALICE) } }));
    const darkBody = await darkPage.text();
    expect(darkBody).toContain('<html lang="en" data-theme="ink">');
    expect(darkBody).toContain('<meta name="theme-color" content="#14151a"/>');
    expect(darkBody).toContain('data-cp-reader data-cp-font="sans" data-cp-text-size="large" data-cp-line-spacing="loose" data-cp-paragraph-spacing="compact" data-cp-text-width="wide"');
    expect(darkBody).toContain('autocomplete="off"');

    for (const theme of ["light", "auto"] as const) {
      await post(app, "/settings", new URLSearchParams({ ...values, theme }).toString(), {
        "content-type": "application/x-www-form-urlencoded",
        cookie: session(ALICE),
      });
      const response = await app.handle(new Request("http://localhost/settings", { headers: { cookie: session(ALICE) } }));
      const rendered = await response.text();
      if (theme === "light") expect(rendered).toContain('data-theme="parchment"');
      else expect(rendered).not.toContain("data-theme=");
    }

    const script = await app.handle(new Request("http://localhost/reader-settings.js"));
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("text/javascript");
    expect((await script.text()).length).toBeGreaterThan(0);
  });

  test("a signed-out reader cannot access settings", async () => {
    const env = await environment("settings-auth");
    const app = buildApp({ db: env.db, config: { ...config, items_root: env.itemsRoot }, now });
    const response = await app.handle(new Request("http://localhost/settings"));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login");
  });
});

describe("generated stylesheet", () => {
  test("keeps light and dark highlight washes distinct", async () => {
    const child = Bun.spawn(["bun", "run", "css"], {
      cwd: repoRoot,
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await child.exited).toBe(0);
    const css = await readFile(join(repoRoot, "public", "app.css"), "utf8");
    expect(css).toContain("rgb(214 148 61 / 0.28)");
    expect(css).toContain("rgb(217 155 78 / 0.24)");
  });
});

describe("in-process worker", () => {
  test("drains queued work and stops", async () => {
    const env = await environment("worker");
    enqueueFetch(env.db, {
      id: newRequestId(), user_id: ALICE, item_id: null,
      url: "https://example.com/queued", state: "queued",
      lease_expires_at: null, attempts: 0, error_code: null,
      created_at: toIso(now()),
    });
    const worker = startWorker({ db: env.db, itemsRoot: env.itemsRoot, now, capture: env.capture, browserPath: "/usr/bin/chromium" });
    const deadline = performance.now() + 10_000;
    while (listItems(env.db, ALICE, 10).length === 0 && performance.now() < deadline) await Bun.sleep(25);
    await worker.stop();
    expect(listItems(env.db, ALICE, 10)).toHaveLength(1);
  }, 20_000);
});
