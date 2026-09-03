import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { parseConfig } from "../../src/contracts/config";
import { asUserId } from "../../src/contracts/ids";
import type { User } from "../../src/contracts/item";
import { migrate } from "../../src/store/db";
import { insertUser } from "../../src/store/users";
import { buildApp } from "../../src/web/server";
import {
  SESSION_COOKIE,
  authenticate,
  completeLogin,
  createApiToken,
  discover,
  revokeApiToken,
  signPayload,
  startLogin,
  verifyPayload,
} from "../../src/services/auth";

const SECRET = "0123456789abcdef0123456789abcdef";
const ISSUER = "https://issuer.example.com";
const NOW = new Date("2026-09-01T12:00:00.000Z");
const ALICE = asUserId("11111111-1111-4111-8111-111111111111");
const BOB = asUserId("22222222-2222-4222-8222-222222222222");
const CONFIG = parseConfig([
  'db_root = "/tmp/commonplace/db"',
  'items_root = "/tmp/commonplace/items"',
  'base_url = "https://reader.example.com"',
  `issuer_url = "${ISSUER}"`,
  'client_id = "commonplace"',
  'client_secret = "client-secret"',
  `session_secret = "${SECRET}"`,
  'browser_path = "/usr/bin/chromium"',
].join("\n"));

function db(): Database {
  const value = new Database(":memory:");
  migrate(value, NOW);
  return value;
}

function user(id: typeof ALICE, subject: string): User {
  return { id, subject, email: `${subject}@example.com`, created_at: NOW.toISOString() };
}

function signedSession(userId: typeof ALICE): string {
  return `${SESSION_COOKIE}=${signPayload(SECRET, {
    user_id: userId,
    exp: new Date(NOW.getTime() + 60_000).toISOString(),
  })}`;
}

function issuer(nonceHolder: { value: string } = { value: "" }): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    void init;
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    if (url.pathname === "/.well-known/openid-configuration") {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
      });
    }
    if (url.pathname === "/token") {
      const claims = {
        iss: ISSUER,
        aud: CONFIG.client_id,
        sub: "passkey-subject",
        nonce: nonceHolder.value,
        exp: Math.floor(NOW.getTime() / 1000) + 300,
      };
      return Response.json({ id_token: `${btoa("{}")}.${btoa(JSON.stringify(claims))}.ignored` });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

function token(claims: Record<string, unknown>): string {
  return `${btoa("{}")}.${btoa(JSON.stringify(claims))}.ignored`;
}

async function callbackWith(
  claims: Record<string, unknown> = {},
  status = 200,
): Promise<unknown> {
  const database = db();
  const nonceHolder = { value: "" };
  const endpoints = await discover(CONFIG, issuer(nonceHolder));
  const started = startLogin(CONFIG, endpoints, "https://reader.example.com/login/callback", NOW);
  const cookie = started.setCookie.split(";")[0]!;
  const attempt = verifyPayload(SECRET, cookie.slice(cookie.indexOf("=") + 1), NOW)!;
  nonceHolder.value = String(attempt.nonce);
  const base = issuer(nonceHolder);
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await base(input, init);
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url).pathname;
    if (path !== "/token") return response;
    if (status !== 200) return new Response("rejected", { status });
    return Response.json({
      id_token: token({
        iss: ISSUER,
        aud: CONFIG.client_id,
        sub: "callback-subject",
        nonce: attempt.nonce,
        exp: Math.floor(NOW.getTime() / 1000) + 300,
        ...claims,
      }),
    });
  }) as unknown as typeof fetch;
  return completeLogin({
    config: CONFIG,
    db: database,
    url: new URL(`https://reader.example.com/login/callback?code=code&state=${attempt.state}`),
    cookieHeader: cookie,
    redirectUri: "https://reader.example.com/login/callback",
    now: NOW,
    fetchImpl,
  });
}

describe("signed credentials", () => {
  test("accepts a signed payload and rejects tampering or expiry", () => {
    const signed = signPayload(SECRET, { user_id: ALICE, exp: "2026-10-01T00:00:00.000Z" });
    expect(verifyPayload(SECRET, signed, NOW)).toMatchObject({ user_id: ALICE });
    const [body] = signed.split(".");
    expect(verifyPayload(SECRET, `${body}.bad`, NOW)).toBeNull();
    const expired = signPayload(SECRET, { user_id: ALICE, exp: "2026-08-01T00:00:00.000Z" });
    expect(verifyPayload(SECRET, expired, NOW)).toBeNull();
  });

  test("requires a valid session or bearer token and applies tenant ownership", async () => {
    const database = db();
    insertUser(database, user(ALICE, "alice"));
    insertUser(database, user(BOB, "bob"));
    await expect(authenticate(new Request("https://reader.example.com"), { db: database, config: CONFIG, now: NOW })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });

    const created = createApiToken(database, ALICE, "phone", NOW);
    const principal = await authenticate(new Request("https://reader.example.com", { headers: { authorization: `Bearer ${created.secret}` } }), { db: database, config: CONFIG, now: NOW });
    expect(principal.user.id).toBe(ALICE);
    expect(principal.via).toBe("token");
    revokeApiToken(database, ALICE, created.token.id);
    await expect(authenticate(new Request("https://reader.example.com", { headers: { authorization: `Bearer ${created.secret}` } }), { db: database, config: CONFIG, now: NOW })).rejects.toMatchObject({ code: "AUTH_TOKEN_INVALID" });
    database.close();
  });
});

describe("OIDC login", () => {
  test("pins discovery to the configured HTTPS issuer", async () => {
    await expect(discover(CONFIG, issuer())).resolves.toMatchObject({ issuer: ISSUER });
    const foreign = (async (): Promise<Response> => Response.json({
      issuer: ISSUER,
      authorization_endpoint: "https://evil.example/authorize",
      token_endpoint: `${ISSUER}/token`,
    })) as unknown as typeof fetch;
    await expect(discover(CONFIG, foreign)).rejects.toMatchObject({ code: "AUTH_ISSUER_MISMATCH" });
    const foreignToken = (async (): Promise<Response> => Response.json({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: "https://evil.example/token",
    })) as unknown as typeof fetch;
    await expect(discover(CONFIG, foreignToken)).rejects.toMatchObject({ code: "AUTH_ISSUER_MISMATCH" });
  });

  test("rejects failed, malformed, and incomplete discovery responses", async () => {
    const failed = (async (): Promise<Response> => new Response("down", { status: 503 })) as unknown as typeof fetch;
    await expect(discover(CONFIG, failed)).rejects.toMatchObject({ code: "AUTH_DISCOVERY_FAILED" });
    const malformed = (async (): Promise<Response> => new Response("not json")) as unknown as typeof fetch;
    await expect(discover(CONFIG, malformed)).rejects.toMatchObject({ code: "AUTH_DISCOVERY_FAILED" });
    const incomplete = (async (): Promise<Response> => Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize` })) as unknown as typeof fetch;
    await expect(discover(CONFIG, incomplete)).rejects.toMatchObject({ code: "AUTH_ISSUER_MISMATCH" });
  });

  test("redirects /login with the discovered authorization and OIDC parameters", async () => {
    const database = db();
    const app = buildApp({ db: database, config: CONFIG, now: () => NOW });
    const discoveryCalls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      discoveryCalls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oidc/authorize`,
        token_endpoint: `${ISSUER}/token`,
      });
    }) as typeof fetch;

    try {
      const response = await app.handle(new Request("https://reader.example.com/login"));
      expect(response.status).toBe(303);
      expect(discoveryCalls).toEqual([`${ISSUER}/.well-known/openid-configuration`]);

      const location = response.headers.get("location");
      expect(location).toBeTruthy();
      const authorization = new URL(location!);
      expect(authorization.origin).toBe(ISSUER);
      expect(authorization.pathname).toBe("/oidc/authorize");
      expect(authorization.searchParams.get("response_type")).toBe("code");
      expect(authorization.searchParams.get("client_id")).toBe(CONFIG.client_id);
      expect(authorization.searchParams.get("redirect_uri")).toBe("https://reader.example.com/login/callback");
      expect(authorization.searchParams.get("scope")).toBe("openid email profile");
      expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");

      const cookie = response.headers.get("set-cookie")?.match(/^cp_login=([^;]+)/)?.[1];
      expect(cookie).toBeDefined();
      const attempt = verifyPayload(SECRET, cookie!, NOW);
      expect(attempt).not.toBeNull();
      expect(authorization.searchParams.get("state")).toBe(String(attempt?.state));
      expect(authorization.searchParams.get("nonce")).toBe(String(attempt?.nonce));
      const challenge = new Bun.CryptoHasher("sha256")
        .update(String(attempt?.code_verifier))
        .digest("base64url");
      expect(authorization.searchParams.get("code_challenge")).toBe(challenge);
    } finally {
      globalThis.fetch = originalFetch;
      database.close();
    }
  });

  test("binds callback state to the login cookie and creates a session", async () => {
    const database = db();
    const nonceHolder = { value: "" };
    const fetchImpl = issuer(nonceHolder);
    const endpoints = await discover(CONFIG, fetchImpl);
    const started = startLogin(CONFIG, endpoints, "https://reader.example.com/login/callback", NOW);
    const cookie = started.setCookie.split(";")[0]!;
    const attempt = verifyPayload(SECRET, cookie.slice(cookie.indexOf("=") + 1), NOW)!;
    nonceHolder.value = String(attempt.nonce);
    const callback = new URL(`https://reader.example.com/login/callback?code=code&state=${encodeURIComponent(String(attempt.state))}`);
    const result = await completeLogin({
      config: CONFIG,
      db: database,
      url: callback,
      cookieHeader: cookie,
      redirectUri: "https://reader.example.com/login/callback",
      now: NOW,
      fetchImpl,
    });
    expect(result.user.subject).toBe("passkey-subject");
    expect(verifyPayload(SECRET, result.setCookie.split(";")[0]!.split("=").slice(1).join("="), NOW)).toMatchObject({ user_id: result.user.id });
    expect(result.clearCookie).toContain("Max-Age=0");
    database.close();
  });

  test("rejects a callback with the wrong state", async () => {
    const database = db();
    const endpoints = await discover(CONFIG, issuer());
    const started = startLogin(CONFIG, endpoints, "https://reader.example.com/login/callback", NOW);
    await expect(completeLogin({
      config: CONFIG,
      db: database,
      url: new URL("https://reader.example.com/login/callback?code=code&state=wrong"),
      cookieHeader: started.setCookie.split(";")[0]!,
      redirectUri: "https://reader.example.com/login/callback",
      now: NOW,
      fetchImpl: issuer(),
    })).rejects.toMatchObject({ code: "AUTH_STATE_MISMATCH" });
    database.close();
  });

  test("rejects token exchange failures and invalid ID token claims", async () => {
    await expect(callbackWith({}, 400)).rejects.toMatchObject({ code: "AUTH_EXCHANGE_FAILED" });
    await expect(callbackWith({ aud: "other-client" })).rejects.toMatchObject({ code: "AUTH_TOKEN_INVALID" });
    await expect(callbackWith({ exp: Math.floor(NOW.getTime() / 1000) - 1 })).rejects.toMatchObject({ code: "AUTH_TOKEN_EXPIRED" });
    await expect(callbackWith({ nonce: "wrong-nonce" })).rejects.toMatchObject({ code: "AUTH_TOKEN_INVALID" });
    await expect(callbackWith({ sub: "" })).rejects.toMatchObject({ code: "AUTH_TOKEN_INVALID" });
    await expect(callbackWith({ aud: ["other-client"] })).rejects.toMatchObject({ code: "AUTH_TOKEN_INVALID" });
    await expect(callbackWith({ aud: ["other-client", CONFIG.client_id] })).resolves.toMatchObject({
      user: { subject: "callback-subject" },
    });
  });

  test("rejects an ID token from another issuer", async () => {
    const database = db();
    const endpoints = await discover(CONFIG, issuer());
    const started = startLogin(CONFIG, endpoints, "https://reader.example.com/login/callback", NOW);
    const cookie = started.setCookie.split(";")[0]!;
    const attempt = verifyPayload(SECRET, cookie.slice(cookie.indexOf("=") + 1), NOW)!;
    const badIssuer = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const response = await (issuer()(input, init));
      if (new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url).pathname !== "/token") return response;
      return Response.json({ id_token: token({ iss: "https://evil.example", aud: CONFIG.client_id, sub: "x", nonce: attempt.nonce, exp: 2_000_000_000 }) });
    };
    await expect(completeLogin({
      config: CONFIG,
      db: database,
      url: new URL(`https://reader.example.com/login/callback?code=code&state=${attempt.state}`),
      cookieHeader: cookie,
      redirectUri: "https://reader.example.com/login/callback",
      now: NOW,
      fetchImpl: badIssuer as unknown as typeof fetch,
    })).rejects.toMatchObject({ code: "AUTH_ISSUER_MISMATCH" });
    database.close();
  });
});
