import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addMs, now, toIso } from "../../src/contracts/clock";
import type { Config } from "../../src/contracts/config";
import { parseConfig } from "../../src/contracts/config";
import { asUserId, newRequestId } from "../../src/contracts/ids";
import type { User } from "../../src/contracts/item";
import type { CaptureRequest, CaptureResult } from "../../src/services/acquire";
import { authenticate, createApiToken, signPayload } from "../../src/services/auth";
import { startWorker } from "../../src/services/worker";
import { openDatabase } from "../../src/store/db";
import { listItems } from "../../src/store/items";
import { enqueueFetch } from "../../src/store/queue";
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

function form(value: string): { body: string; headers: Record<string, string> } {
  return { body: new URLSearchParams({ url: value }).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } };
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
  test("a signed-in form enqueues work and returns to the library", async () => {
    const env = await environment("form");
    const app = buildApp({ db: env.db, config: { ...config, items_root: env.itemsRoot }, now });
    const input = form("https://example.com/article");
    const response = await post(app, "/items", input.body, { ...input.headers, cookie: session(ALICE) });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/library");
    expect(queuedCount(env.db, ALICE)).toBe(1);
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
    expect((await response.json() as { state: string }).state).toBe("queued");
    expect(queuedCount(env.db, BOB)).toBe(1);
    expect(queuedCount(env.db, ALICE)).toBe(0);
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
