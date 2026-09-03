// Acceptance test for milestone 4. It is the specification for that work.
// Change it only when the design changes, and say what changed and why.
//
// What the implementer must create
// --------------------------------
// 1. `src/services/auth.ts`, with the API this file imports.
// 2. `newSecret` in `src/contracts/ids.ts`.
// 3. The seven `AUTH_*` codes in `src/contracts/errors.ts`.
// 4. `checkRouteGuard` in `test/invariants/lib.ts`, plus its own two tests in
//    `test/invariants/route-guard.test.ts`.
// 5. Three new banned calls in `checkDeterminism`.
//
// This file records the authentication behavior as assertions.
//
// Facts verified against Bun 1.4.0 before this file was written
// -------------------------------------------------------------
// - `node:crypto`'s `timingSafeEqual` THROWS when the two buffers differ in
//   length. So the verifier must compare lengths first and return null, which
//   is what the "rejects a truncated signature" test below pins.
// - `Buffer.from(x).toString("base64url")` round-trips, and `Bun.CryptoHasher`
//   accepts a `"base64url"` digest.
//
// Times are ISO strings, not epoch numbers
// ----------------------------------------
// Our own two cookies carry `exp` as an ISO 8601 string, matching every other
// timestamp in this codebase. A JWT's `exp` is epoch seconds, because that is
// what the JWT specification says. The two units are different on purpose, and
// mixing them is the mistake this note exists to prevent.
//
// Why the ID token's signature is never checked
// ---------------------------------------------
// The token arrives in the body of a direct HTTPS request the server makes to
// the token endpoint, whose origin is pinned to the configured issuer. OpenID
// Connect Core 3.1.3.7 item 6 allows TLS server validation to stand in for the
// signature check in exactly that case. The tests below therefore build ID
// tokens with a fake signature segment, and that is not an oversight.
//
// The pin is what makes it safe, so the discovery tests below are the most
// important tests in this file.

import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";

import { AppError, ERROR_CODES, isAppError } from "../../src/contracts/errors";
import { parseConfig } from "../../src/contracts/config";
import type { Config } from "../../src/contracts/config";
import type { UserId } from "../../src/contracts/ids";
import { asUserId, newSecret, newUserId } from "../../src/contracts/ids";
import type { User } from "../../src/contracts/item";
import { migrate, openDatabase } from "../../src/store/db";
import { getUser, insertUser } from "../../src/store/users";
import {
  UNGUARDED_ROUTES,
  checkDeterminism,
  checkRouteGuard,
  listSources,
} from "../invariants/lib";
import {
  LOGIN_COOKIE,
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
const REDIRECT_URI = "https://reader.example.com/login/callback";
const NOW = new Date("2026-09-01T12:00:00.000Z");

const CONFIG: Config = parseConfig(
  [
    'db_root = "/tmp/commonplace-auth/db"',
    'items_root = "/tmp/commonplace-auth/items"',
    'base_url = "https://reader.example.com"',
    `issuer_url = "${ISSUER}"`,
    'client_id = "commonplace-test"',
    'client_secret = "test-client-secret"',
    `session_secret = "${SECRET}"`,
    'browser_path = "/usr/bin/chromium"',
  ].join("\n"),
);

function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

async function caughtAsync(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to reject");
}

function b64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function makeIdToken(claims: Record<string, unknown>): string {
  return [
    b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })),
    b64url(JSON.stringify(claims)),
    "not-a-real-signature",
  ].join(".");
}

// Configure the fake issuer to return invalid values so each validation path
// can be tested.
type IssuerOptions = {
  discoveryIssuer?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  discoveryBody?: string;
  discoveryStatus?: number;
  tokenStatus?: number;
  claims?: Record<string, unknown>;
  onTokenRequest?: (body: URLSearchParams) => void;
  // A real issuer copies the authorization request nonce into the ID token.
  // Because the fake doesn't receive that request, the login helper supplies
  // the nonce after `startLogin`.
  nonceHolder?: { value: string };
};

function fakeIssuer(options: IssuerOptions = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );

    if (url.pathname === "/.well-known/openid-configuration") {
      if (options.discoveryStatus && options.discoveryStatus !== 200) {
        return new Response("nope", { status: options.discoveryStatus });
      }
      const body =
        options.discoveryBody ??
        JSON.stringify({
          issuer: options.discoveryIssuer ?? ISSUER,
          authorization_endpoint:
            options.authorizationEndpoint ?? `${ISSUER}/authorize`,
          token_endpoint: options.tokenEndpoint ?? `${ISSUER}/token`,
        });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname === "/token") {
      const body = new URLSearchParams(String(init?.body ?? ""));
      options.onTokenRequest?.(body);
      if (options.tokenStatus && options.tokenStatus !== 200) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: options.tokenStatus,
          headers: { "content-type": "application/json" },
        });
      }
      const claims = {
        iss: ISSUER,
        aud: CONFIG.client_id,
        sub: "passkey-subject-1",
        nonce: options.nonceHolder?.value ?? "",
        email: "reader@example.com",
        exp: Math.floor(NOW.getTime() / 1000) + 300,
        iat: Math.floor(NOW.getTime() / 1000),
        ...options.claims,
      };
      return new Response(
        JSON.stringify({
          access_token: "an-access-token",
          token_type: "Bearer",
          id_token: makeIdToken(claims),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

async function endpoints(fetchImpl = fakeIssuer()) {
  return discover(CONFIG, fetchImpl);
}

// Drive a whole login and return what the callback was given.
async function login(options: IssuerOptions = {}, overrides: {
  state?: string;
  nonce?: string;
  now?: Date;
  db?: Database;
} = {}) {
  const nonceHolder = { value: "" };
  const fetchImpl = fakeIssuer({ nonceHolder, ...options });
  const eps = await endpoints(fetchImpl);
  const started = startLogin(CONFIG, eps, REDIRECT_URI, NOW);
  const authorizeUrl = new URL(started.redirectUrl);
  const cookie = started.setCookie.split(";")[0]!;
  const attempt = verifyPayload(SECRET, cookie.split("=")[1]!, NOW) as {
    state: string;
    nonce: string;
    code_verifier: string;
  };
  nonceHolder.value = attempt.nonce;
  const state = overrides.state ?? attempt.state;
  const callbackUrl = new URL(
    `${REDIRECT_URI}?code=an-auth-code&state=${encodeURIComponent(state)}`,
  );
  const db = overrides.db ?? freshDb();
  return {
    authorizeUrl,
    attempt,
    db,
    run: () =>
      completeLogin({
        config: CONFIG,
        db,
        url: callbackUrl,
        cookieHeader: cookie,
        redirectUri: REDIRECT_URI,
        now: overrides.now ?? NOW,
        fetchImpl,
      }),
  };
}

function freshDb(): Database {
  const db = openDatabase(":memory:", NOW);
  migrate(db, NOW);
  return db;
}

function seedUser(
  db: Database,
  id: UserId = newUserId(),
  subject = "existing-subject",
): User {
  return insertUser(db, {
    id,
    subject,
    email: "existing@example.com",
    created_at: NOW.toISOString(),
  });
}

describe("the error codes exist", () => {
  const codes = [
    "AUTH_REQUIRED",
    "AUTH_STATE_MISMATCH",
    "AUTH_TOKEN_INVALID",
    "AUTH_TOKEN_EXPIRED",
    "AUTH_DISCOVERY_FAILED",
    "AUTH_ISSUER_MISMATCH",
    "AUTH_EXCHANGE_FAILED",
  ];
  for (const code of codes) {
    test(code, () => {
      expect([...ERROR_CODES] as string[]).toContain(code);
    });
  }
});

describe("newSecret", () => {
  test("returns base64url with no padding", () => {
    expect(newSecret(32)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("returns a different value every call", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) seen.add(newSecret(32));
    expect(seen.size).toBe(50);
  });

  test("32 bytes encode to 43 base64url characters", () => {
    expect(newSecret(32).length).toBe(43);
  });
});

describe("the determinism checker closes the randomness hole", () => {
  // Without these, the PKCE verifier, the state, the nonce, and every API
  // token secret would each be an unreviewable source of randomness in L3.
  const banned = [
    'const bytes = crypto.getRandomValues(new Uint8Array(32));',
    'await crypto.subtle.digest("SHA-256", data);',
    'const bytes = crypto.randomBytes(32);',
  ];
  for (const source of banned) {
    test(`flags ${source.slice(0, 40)}`, () => {
      const violations = checkDeterminism([
        { path: "src/services/auth.ts", source },
      ]);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0]!.rule).toBe("determinism");
    });
  }

  test("allows them inside src/contracts/ids.ts", () => {
    expect(
      checkDeterminism([
        {
          path: "src/contracts/ids.ts",
          source: "crypto.getRandomValues(new Uint8Array(32));",
        },
      ]),
    ).toEqual([]);
  });

  test("still allows the deterministic hashers", () => {
    expect(
      checkDeterminism([
        {
          path: "src/services/auth.ts",
          source: 'createHmac("sha256", k); timingSafeEqual(a, b); new Bun.CryptoHasher("sha256");',
        },
      ]),
    ).toEqual([]);
  });
});

describe("signed payloads", () => {
  const payload = { user_id: "abc", exp: "2026-10-01T00:00:00.000Z" };

  test("round-trips", () => {
    const signed = signPayload(SECRET, payload);
    expect(verifyPayload(SECRET, signed, NOW)).toEqual(payload);
  });

  test("is two base64url segments joined by a dot", () => {
    const signed = signPayload(SECRET, payload);
    expect(signed.split(".").length).toBe(2);
    for (const part of signed.split(".")) {
      expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  test("rejects a tampered payload", () => {
    const signed = signPayload(SECRET, payload);
    const [, signature] = signed.split(".");
    const forged = `${b64url(JSON.stringify({ ...payload, user_id: "someone-else" }))}.${signature}`;
    expect(verifyPayload(SECRET, forged, NOW)).toBeNull();
  });

  test("rejects a tampered signature", () => {
    const signed = signPayload(SECRET, payload);
    const [body, signature] = signed.split(".");
    const flipped = signature!.startsWith("A")
      ? `B${signature!.slice(1)}`
      : `A${signature!.slice(1)}`;
    expect(verifyPayload(SECRET, `${body}.${flipped}`, NOW)).toBeNull();
  });

  test("rejects a signature made with another secret", () => {
    const other = "f".repeat(32);
    const body = b64url(JSON.stringify(payload));
    const signature = createHmac("sha256", other).update(body).digest("base64url");
    expect(verifyPayload(SECRET, `${body}.${signature}`, NOW)).toBeNull();
  });

  test("rejects a truncated signature rather than throwing", () => {
    // node:crypto's timingSafeEqual throws when the lengths differ, so the
    // verifier has to compare lengths itself.
    const signed = signPayload(SECRET, payload);
    const [body, signature] = signed.split(".");
    expect(verifyPayload(SECRET, `${body}.${signature!.slice(0, 10)}`, NOW)).toBeNull();
  });

  test("rejects a value with no dot", () => {
    expect(verifyPayload(SECRET, "not-a-signed-value", NOW)).toBeNull();
  });

  test("rejects an empty value", () => {
    expect(verifyPayload(SECRET, "", NOW)).toBeNull();
  });

  test("rejects a payload that is signed but not JSON", () => {
    const body = b64url("this is not json");
    const signature = createHmac("sha256", SECRET).update(body).digest("base64url");
    expect(verifyPayload(SECRET, `${body}.${signature}`, NOW)).toBeNull();
  });

  test("rejects an expired payload", () => {
    const signed = signPayload(SECRET, {
      user_id: "abc",
      exp: "2026-08-01T00:00:00.000Z",
    });
    expect(verifyPayload(SECRET, signed, NOW)).toBeNull();
  });

  test("accepts a payload that expires one second from now", () => {
    const signed = signPayload(SECRET, {
      user_id: "abc",
      exp: new Date(NOW.getTime() + 1000).toISOString(),
    });
    expect(verifyPayload(SECRET, signed, NOW)).not.toBeNull();
  });

  test("rejects a payload with no exp", () => {
    const body = b64url(JSON.stringify({ user_id: "abc" }));
    const signature = createHmac("sha256", SECRET).update(body).digest("base64url");
    expect(verifyPayload(SECRET, `${body}.${signature}`, NOW)).toBeNull();
  });
});

describe("discovery is pinned to the configured issuer", () => {
  test("returns the three endpoints", async () => {
    const eps = await endpoints();
    expect(eps.issuer).toBe(ISSUER);
    expect(eps.authorization_endpoint).toBe(`${ISSUER}/authorize`);
    expect(eps.token_endpoint).toBe(`${ISSUER}/token`);
  });

  test("asks the configured issuer for its document", async () => {
    let asked = "";
    const spy = (async (input: string | URL | Request) => {
      asked = typeof input === "string" ? input : String(input);
      return fakeIssuer()(input as never);
    }) as unknown as typeof fetch;
    await discover(CONFIG, spy);
    expect(asked).toBe(`${ISSUER}/.well-known/openid-configuration`);
  });

  test("throws AUTH_DISCOVERY_FAILED when the fetch fails", async () => {
    const dead = (async () => {
      throw new TypeError("connection refused");
    }) as unknown as typeof fetch;
    const error = await caughtAsync(() => discover(CONFIG, dead));
    expect(isAppError(error)).toBe(true);
    expect((error as AppError).code).toBe("AUTH_DISCOVERY_FAILED");
  });

  test("throws AUTH_DISCOVERY_FAILED for a non-200 response", async () => {
    const error = await caughtAsync(() =>
      discover(CONFIG, fakeIssuer({ discoveryStatus: 500 })),
    );
    expect((error as AppError).code).toBe("AUTH_DISCOVERY_FAILED");
  });

  test("throws AUTH_DISCOVERY_FAILED when the body is not JSON", async () => {
    const error = await caughtAsync(() =>
      discover(CONFIG, fakeIssuer({ discoveryBody: "<html>nope</html>" })),
    );
    expect((error as AppError).code).toBe("AUTH_DISCOVERY_FAILED");
  });

  // These four are the milestone. Each one hands the client secret to a host
  // the operator never named.
  test("rejects a document whose issuer is another host", async () => {
    const error = await caughtAsync(() =>
      discover(CONFIG, fakeIssuer({ discoveryIssuer: "https://evil.example" })),
    );
    expect((error as AppError).code).toBe("AUTH_ISSUER_MISMATCH");
  });

  test("rejects a token endpoint on another origin", async () => {
    const error = await caughtAsync(() =>
      discover(CONFIG, fakeIssuer({ tokenEndpoint: "https://evil.example/token" })),
    );
    expect((error as AppError).code).toBe("AUTH_ISSUER_MISMATCH");
  });

  test("rejects an authorization endpoint on another origin", async () => {
    const error = await caughtAsync(() =>
      discover(
        CONFIG,
        fakeIssuer({ authorizationEndpoint: "https://evil.example/authorize" }),
      ),
    );
    expect((error as AppError).code).toBe("AUTH_ISSUER_MISMATCH");
  });

  test("rejects a token endpoint that is not https", async () => {
    const error = await caughtAsync(() =>
      discover(CONFIG, fakeIssuer({ tokenEndpoint: "http://issuer.example.com/token" })),
    );
    expect((error as AppError).code).toBe("AUTH_ISSUER_MISMATCH");
  });

  test("rejects a document missing the token endpoint", async () => {
    const error = await caughtAsync(() =>
      discover(
        CONFIG,
        fakeIssuer({
          discoveryBody: JSON.stringify({
            issuer: ISSUER,
            authorization_endpoint: `${ISSUER}/authorize`,
          }),
        }),
      ),
    );
    expect((error as AppError).code).toBe("AUTH_ISSUER_MISMATCH");
  });
});

describe("startLogin", () => {
  test("sends the browser to the authorization endpoint", async () => {
    const { authorizeUrl } = await login();
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(`${ISSUER}/authorize`);
  });

  test("asks for the code flow with our client and redirect", async () => {
    const { authorizeUrl } = await login();
    const q = authorizeUrl.searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe(CONFIG.client_id);
    expect(q.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(q.get("scope")!.split(" ")).toContain("openid");
  });

  test("uses S256, never plain", async () => {
    const { authorizeUrl } = await login();
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
  });

  test("the challenge is the base64url SHA-256 of the verifier", async () => {
    const { authorizeUrl, attempt } = await login();
    const expected = new Bun.CryptoHasher("sha256")
      .update(attempt.code_verifier)
      .digest("base64url");
    expect(authorizeUrl.searchParams.get("code_challenge")).toBe(expected);
  });

  test("the state and nonce in the URL match the cookie", async () => {
    const { authorizeUrl, attempt } = await login();
    expect(authorizeUrl.searchParams.get("state")).toBe(attempt.state);
    expect(authorizeUrl.searchParams.get("nonce")).toBe(attempt.nonce);
  });

  test("state, nonce, and verifier are all different from each other", async () => {
    const { attempt } = await login();
    const values = [attempt.state, attempt.nonce, attempt.code_verifier];
    expect(new Set(values).size).toBe(3);
    for (const value of values) expect(value.length).toBeGreaterThanOrEqual(43);
  });

  test("two logins never share a state", async () => {
    const first = await login();
    const second = await login();
    expect(first.attempt.state).not.toBe(second.attempt.state);
  });

  test("the login cookie is HttpOnly, Secure, SameSite=Lax, and rooted", async () => {
    const eps = await endpoints();
    const { setCookie } = startLogin(CONFIG, eps, REDIRECT_URI, NOW);
    expect(setCookie.startsWith(`${LOGIN_COOKIE}=`)).toBe(true);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
  });
});

describe("completeLogin, the happy path", () => {
  test("creates the user named by the subject claim", async () => {
    const { run, db } = await login();
    const { user } = await run();
    expect(user.subject).toBe("passkey-subject-1");
    expect(getUser(db, user.id)).not.toBeNull();
  });

  test("reuses an existing user rather than making a second one", async () => {
    const db = freshDb();
    const first = await login({}, { db });
    const created = (await first.run()).user;
    const second = await login({}, { db });
    const again = (await second.run()).user;
    expect(again.id).toBe(created.id);
  });

  test("mints a session cookie the guard accepts", async () => {
    const { run } = await login();
    const { setCookie, user } = await run();
    expect(setCookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    const value = setCookie.split(";")[0]!.split("=").slice(1).join("=");
    const payload = verifyPayload(SECRET, value, NOW) as { user_id: string };
    expect(asUserId(payload.user_id)).toBe(user.id);
  });

  test("the session cookie is HttpOnly, Secure, SameSite=Lax, and rooted", async () => {
    const { run } = await login();
    const { setCookie } = await run();
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
  });

  test("clears the login cookie", async () => {
    const { run } = await login();
    const { clearCookie } = await run();
    expect(clearCookie.startsWith(`${LOGIN_COOKIE}=`)).toBe(true);
    expect(clearCookie).toContain("Max-Age=0");
  });

  test("sends the PKCE verifier and the client credentials to the token endpoint", async () => {
    let body: URLSearchParams | null = null;
    const { run, attempt } = await login({
      onTokenRequest: (sent) => {
        body = sent;
      },
    });
    await run();
    const sent = body as unknown as URLSearchParams;
    expect(sent.get("grant_type")).toBe("authorization_code");
    expect(sent.get("code")).toBe("an-auth-code");
    expect(sent.get("code_verifier")).toBe(attempt.code_verifier);
    expect(sent.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(sent.get("client_id")).toBe(CONFIG.client_id);
    expect(sent.get("client_secret")).toBe(CONFIG.client_secret);
  });
});

describe("completeLogin rejects every bad callback", () => {
  test("a state that does not match the cookie", async () => {
    const { run } = await login({}, { state: "a-state-we-never-minted" });
    const error = await caughtAsync(run);
    expect((error as AppError).code).toBe("AUTH_STATE_MISMATCH");
  });

  test("no login cookie at all", async () => {
    const eps = await endpoints();
    const started = startLogin(CONFIG, eps, REDIRECT_URI, NOW);
    const url = new URL(`${REDIRECT_URI}?code=c&state=s`);
    void started;
    const error = await caughtAsync(() =>
      completeLogin({
        config: CONFIG,
        db: freshDb(),
        url,
        cookieHeader: null,
        redirectUri: REDIRECT_URI,
        now: NOW,
        fetchImpl: fakeIssuer(),
      }),
    );
    expect((error as AppError).code).toBe("AUTH_STATE_MISMATCH");
  });

  test("a login cookie that expired while the user was away", async () => {
    const later = new Date(NOW.getTime() + 11 * 60 * 1000);
    const { run } = await login({}, { now: later });
    const error = await caughtAsync(run);
    expect((error as AppError).code).toBe("AUTH_STATE_MISMATCH");
  });

  test("a code the issuer refuses", async () => {
    const { run } = await login({ tokenStatus: 400 });
    const error = await caughtAsync(run);
    expect((error as AppError).code).toBe("AUTH_EXCHANGE_FAILED");
  });

  test("an ID token whose issuer is not ours", async () => {
    const { run } = await login({ claims: { iss: "https://evil.example" } });
    const error = await caughtAsync(run);
    expect((error as AppError).code).toBe("AUTH_ISSUER_MISMATCH");
  });

  test("an ID token minted for another client", async () => {
    const { run } = await login({ claims: { aud: "some-other-app" } });
    const error = await caughtAsync(run);
    expect((error as AppError).code).toBe("AUTH_TOKEN_INVALID");
  });

  test("an ID token that has expired", async () => {
    const { run } = await login({
      claims: { exp: Math.floor(NOW.getTime() / 1000) - 60 },
    });
    const error = await caughtAsync(run);
    expect((error as AppError).code).toBe("AUTH_TOKEN_EXPIRED");
  });

  test("an ID token carrying somebody else's nonce", async () => {
    const { run } = await login({ claims: { nonce: "a-nonce-we-never-minted" } });
    const error = await caughtAsync(run);
    expect((error as AppError).code).toBe("AUTH_TOKEN_INVALID");
  });

  test("an ID token with no subject", async () => {
    const { run } = await login({ claims: { sub: "" } });
    const error = await caughtAsync(run);
    expect((error as AppError).code).toBe("AUTH_TOKEN_INVALID");
  });

  test("an audience array that does not hold our client id", async () => {
    const { run } = await login({ claims: { aud: ["a", "b"] } });
    const error = await caughtAsync(run);
    expect((error as AppError).code).toBe("AUTH_TOKEN_INVALID");
  });

  test("an audience array that does hold our client id is accepted", async () => {
    const { run } = await login({ claims: { aud: ["other", CONFIG.client_id] } });
    const { user } = await run();
    expect(user.subject).toBe("passkey-subject-1");
  });

  test("no user row is written when the callback fails", async () => {
    const db = freshDb();
    const { run } = await login({ claims: { aud: "wrong" } }, { db });
    await caughtAsync(run);
    const count = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users")
      .get()!;
    expect(count.n).toBe(0);
  });
});

describe("API tokens", () => {
  let db: Database;
  let user: User;

  beforeEach(() => {
    db = freshDb();
    user = seedUser(db);
  });

  test("the secret is returned once and never stored", () => {
    const { token, secret } = createApiToken(db, user.id, "shortcuts", NOW);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token.token_hash).not.toBe(secret);
    expect(token.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the stored hash is the SHA-256 of the secret", () => {
    const { token, secret } = createApiToken(db, user.id, "shortcuts", NOW);
    const expected = new Bun.CryptoHasher("sha256").update(secret).digest("hex");
    expect(token.token_hash).toBe(expected);
  });

  test("two tokens never share a secret", () => {
    const first = createApiToken(db, user.id, "a", NOW).secret;
    const second = createApiToken(db, user.id, "b", NOW).secret;
    expect(first).not.toBe(second);
  });

  test("authenticates a bearer token as its owner", async () => {
    const { secret } = createApiToken(db, user.id, "shortcuts", NOW);
    const principal = await authenticate(
      new Request("https://reader.example.com/items", {
        headers: { authorization: `Bearer ${secret}` },
      }),
      { db, config: CONFIG, now: NOW },
    );
    expect(principal.user.id).toBe(user.id);
    expect(principal.via).toBe("token");
  });

  test("records when a token was last used", async () => {
    const { token, secret } = createApiToken(db, user.id, "shortcuts", NOW);
    expect(token.last_used_at).toBeNull();
    const later = new Date(NOW.getTime() + 60_000);
    await authenticate(
      new Request("https://reader.example.com/items", {
        headers: { authorization: `Bearer ${secret}` },
      }),
      { db, config: CONFIG, now: later },
    );
    const row = db
      .query<{ last_used_at: string | null }, [string]>(
        "SELECT last_used_at FROM api_tokens WHERE id = ?",
      )
      .get(token.id)!;
    expect(row.last_used_at).toBe(later.toISOString());
  });

  test("a revoked token stops working", async () => {
    const { token, secret } = createApiToken(db, user.id, "shortcuts", NOW);
    revokeApiToken(db, user.id, token.id);
    const error = await caughtAsync(() =>
      authenticate(
        new Request("https://reader.example.com/items", {
          headers: { authorization: `Bearer ${secret}` },
        }),
        { db, config: CONFIG, now: NOW },
      ),
    );
    expect((error as AppError).code).toBe("AUTH_TOKEN_INVALID");
  });

  test("an invented token is rejected", async () => {
    const error = await caughtAsync(() =>
      authenticate(
        new Request("https://reader.example.com/items", {
          headers: { authorization: "Bearer i-made-this-up" },
        }),
        { db, config: CONFIG, now: NOW },
      ),
    );
    expect((error as AppError).code).toBe("AUTH_TOKEN_INVALID");
  });
});

describe("the guard", () => {
  let db: Database;
  let user: User;

  beforeEach(() => {
    db = freshDb();
    user = seedUser(db);
  });

  function sessionCookie(id: UserId, exp: Date): string {
    return `${SESSION_COOKIE}=${signPayload(SECRET, {
      user_id: id,
      iat: NOW.toISOString(),
      exp: exp.toISOString(),
    })}`;
  }

  test("accepts a valid session cookie", async () => {
    const exp = new Date(NOW.getTime() + 86_400_000);
    const principal = await authenticate(
      new Request("https://reader.example.com/items", {
        headers: { cookie: sessionCookie(user.id, exp) },
      }),
      { db, config: CONFIG, now: NOW },
    );
    expect(principal.user.id).toBe(user.id);
    expect(principal.via).toBe("session");
  });

  test("finds its cookie among others", async () => {
    const exp = new Date(NOW.getTime() + 86_400_000);
    const principal = await authenticate(
      new Request("https://reader.example.com/items", {
        headers: {
          cookie: `theme=dark; ${sessionCookie(user.id, exp)}; other=1`,
        },
      }),
      { db, config: CONFIG, now: NOW },
    );
    expect(principal.user.id).toBe(user.id);
  });

  test("throws AUTH_REQUIRED when no credential is sent", async () => {
    const error = await caughtAsync(() =>
      authenticate(new Request("https://reader.example.com/items"), {
        db,
        config: CONFIG,
        now: NOW,
      }),
    );
    expect((error as AppError).code).toBe("AUTH_REQUIRED");
  });

  test("throws AUTH_TOKEN_INVALID for a forged session cookie", async () => {
    const forged = `${SESSION_COOKIE}=${b64url(
      JSON.stringify({ user_id: user.id, exp: "2099-01-01T00:00:00.000Z" }),
    )}.forged`;
    const error = await caughtAsync(() =>
      authenticate(
        new Request("https://reader.example.com/items", {
          headers: { cookie: forged },
        }),
        { db, config: CONFIG, now: NOW },
      ),
    );
    expect((error as AppError).code).toBe("AUTH_TOKEN_INVALID");
  });

  test("throws AUTH_TOKEN_INVALID for an expired session", async () => {
    const exp = new Date(NOW.getTime() - 1000);
    const error = await caughtAsync(() =>
      authenticate(
        new Request("https://reader.example.com/items", {
          headers: { cookie: sessionCookie(user.id, exp) },
        }),
        { db, config: CONFIG, now: NOW },
      ),
    );
    expect((error as AppError).code).toBe("AUTH_TOKEN_INVALID");
  });

  test("throws AUTH_TOKEN_INVALID when the session names a deleted user", async () => {
    const exp = new Date(NOW.getTime() + 86_400_000);
    const ghost = newUserId();
    const error = await caughtAsync(() =>
      authenticate(
        new Request("https://reader.example.com/items", {
          headers: { cookie: sessionCookie(ghost, exp) },
        }),
        { db, config: CONFIG, now: NOW },
      ),
    );
    expect((error as AppError).code).toBe("AUTH_TOKEN_INVALID");
  });

  test("prefers the bearer token when both are sent", async () => {
    const other = seedUser(db, newUserId(), "second-subject");
    const { secret } = createApiToken(db, other.id, "shortcuts", NOW);
    const exp = new Date(NOW.getTime() + 86_400_000);
    const principal = await authenticate(
      new Request("https://reader.example.com/items", {
        headers: {
          authorization: `Bearer ${secret}`,
          cookie: sessionCookie(user.id, exp),
        },
      }),
      { db, config: CONFIG, now: NOW },
    );
    expect(principal.via).toBe("token");
    expect(principal.user.id).toBe(other.id);
  });

  test("ignores an Authorization header that is not Bearer", async () => {
    const error = await caughtAsync(() =>
      authenticate(
        new Request("https://reader.example.com/items", {
          headers: { authorization: "Basic dXNlcjpwYXNz" },
        }),
        { db, config: CONFIG, now: NOW },
      ),
    );
    expect((error as AppError).code).toBe("AUTH_REQUIRED");
  });

  test("never returns null", async () => {
    const exp = new Date(NOW.getTime() + 86_400_000);
    const principal = await authenticate(
      new Request("https://reader.example.com/items", {
        headers: { cookie: sessionCookie(user.id, exp) },
      }),
      { db, config: CONFIG, now: NOW },
    );
    expect(principal).not.toBeNull();
    expect(principal.user).toBeDefined();
  });
});

describe("no error message names the credential it rejected", () => {
  test("across every rejection path", async () => {
    const db = freshDb();
    const user = seedUser(db);
    const { secret } = createApiToken(db, user.id, "shortcuts", NOW);
    const forgedCookie = `${SESSION_COOKIE}=${b64url('{"user_id":"x","exp":"2099-01-01T00:00:00.000Z"}')}.forged`;

    const errors: AppError[] = [];
    const cases: HeadersInit[] = [
      { authorization: "Bearer i-made-this-up" },
      { authorization: `Bearer ${secret}x` },
      { cookie: forgedCookie },
      {},
    ];
    for (const headers of cases) {
      const error = await caughtAsync(() =>
        authenticate(new Request("https://reader.example.com/items", { headers }), {
          db,
          config: CONFIG,
          now: NOW,
        }),
      );
      errors.push(error as AppError);
    }

    for (const error of errors) {
      expect(isAppError(error)).toBe(true);
      const text = `${error.message} ${JSON.stringify(error.context)}`;
      expect(text).not.toContain(secret);
      expect(text).not.toContain("i-made-this-up");
      expect(text).not.toContain("forged");
    }
  });
});

describe("the route-guard invariant", () => {
  test("the real repo passes", async () => {
    const root = new URL("../..", import.meta.url).pathname;
    const files = await listSources(root, `${root}src`);
    expect(checkRouteGuard(files)).toEqual([]);
  });

  test("flags a route that neither guards nor is listed", () => {
    const violations = checkRouteGuard([
      {
        path: "src/web/routes/items.ts",
        source: 'app.get("/items", () => listItems());',
      },
    ]);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]!.rule).toBe("route-guard");
  });

  test("accepts a route that calls the guard", () => {
    expect(
      checkRouteGuard([
        {
          path: "src/web/routes/items.ts",
          source:
            'app.get("/items", async ({ request }) => { const p = await authenticate(request, deps); return listItems(p.user.id); });',
        },
      ]),
    ).toEqual([]);
  });

  test("accepts the routes that are named as unguarded", () => {
    expect(
      checkRouteGuard([
        {
          path: "src/web/server.ts",
          source: 'app.get("/health", () => ({ ok: true }));',
        },
      ]),
    ).toEqual([]);
  });

  test("the unguarded list holds exactly the six public paths", () => {
    // Every one of these is public on purpose. `/` is the signed-out landing
    // page, which `test/acceptance/00-foundation.test.ts` requires to answer
    // 200 with no credential. `/app.css` is a static asset built from the
    // repo, and both login paths must work before authentication. `/logout` clears
    // a cookie, which a session that no longer verifies still deserves.
    // Growing this list must break this test, so that opening another way in
    // is a decision somebody made on the record.
    expect([...UNGUARDED_ROUTES].sort()).toEqual([
      "/",
      "/app.css",
      "/health",
      "/login",
      "/login/callback",
      "/logout",
    ]);
  });
});

describe("the app carries no bypass", () => {
  test("nothing in src reads an auth-skipping environment variable", async () => {
    const glob = new Bun.Glob("**/*.{ts,tsx}");
    const root = new URL("../../src", import.meta.url).pathname;
    const offenders: string[] = [];
    for await (const path of glob.scan({ cwd: root, onlyFiles: true })) {
      const source = await Bun.file(`${root}/${path}`).text();
      for (const needle of [
        "SKIP_AUTH",
        "DISABLE_AUTH",
        "NO_AUTH",
        "AUTH_BYPASS",
        "DEV_USER",
      ]) {
        if (source.includes(needle)) offenders.push(`${path}: ${needle}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
