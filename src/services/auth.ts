import { Database } from "bun:sqlite";
import { createHmac, timingSafeEqual } from "node:crypto";

import { addMs, isBefore, parseIso, toIso } from "../contracts/clock";
import type { Config } from "../contracts/config";
import { AppError } from "../contracts/errors";
import type { TokenId, UserId } from "../contracts/ids";
import { asUserId, newSecret, newTokenId, newUserId } from "../contracts/ids";
import type { ApiToken, User } from "../contracts/item";
import {
  deleteApiToken,
  getApiTokenByHash,
  getUser,
  getUserBySubject,
  insertApiToken,
  insertUser,
  touchApiToken,
} from "../store/users";

export const SESSION_COOKIE = "cp_session";
export const LOGIN_COOKIE = "cp_login";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_TTL_MS = 10 * 60 * 1000;

export type Principal = { user: User; via: "session" | "token" };
export type Endpoints = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
};

function attributes(maxAgeSeconds: number): string {
  return `Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

// Max-Age=0 is the browser's "delete this cookie" instruction.
const CLEAR_COOKIE_MAX_AGE_SECONDS = 0;

// The callback route must send this cookie on both paths, success and
// failure, so a failed login never leaves cp_login alive for a second
// state try.
export const CLEAR_LOGIN_COOKIE = `${LOGIN_COOKIE}=; ${attributes(CLEAR_COOKIE_MAX_AGE_SECONDS)}`;

function requiredDiscoveryField(
  record: Record<string, unknown>,
  name: string,
): string {
  const value = record[name];
  if (typeof value !== "string" || value === "") {
    throw new AppError(
      "AUTH_ISSUER_MISMATCH",
      `the discovery document names no ${name}`,
    );
  }
  return value;
}

function sha256Hex(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

export function signPayload(
  secret: string,
  payload: Record<string, unknown>,
): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function verifyPayload(
  secret: string,
  value: string,
  now: Date,
): Record<string, unknown> | null {
  const dot = value.indexOf(".");
  if (dot <= 0 || dot === value.length - 1) return null;
  const body = value.slice(0, dot);
  const signature = value.slice(dot + 1);

  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(signature, "base64url");
  // timingSafeEqual throws on a length mismatch, so check that first.
  if (given.length !== expected.length) return null;
  if (!timingSafeEqual(given, expected)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;

  const record = payload as Record<string, unknown>;
  const exp = record.exp;
  if (typeof exp !== "string") return null;
  let expiresAt: Date;
  try {
    expiresAt = parseIso(exp);
  } catch {
    return null;
  }
  if (!isBefore(now, expiresAt)) return null;
  return record;
}

export async function discover(
  config: Config,
  fetchImpl: typeof fetch = fetch,
): Promise<Endpoints> {
  const url = `${config.issuer_url}/.well-known/openid-configuration`;
  let document: unknown;
  try {
    const response = await fetchImpl(url);
    if (!response.ok) {
      throw new AppError("AUTH_DISCOVERY_FAILED", "the issuer did not answer");
    }
    document = await response.json();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("AUTH_DISCOVERY_FAILED", "the issuer did not answer");
  }

  const record = (document ?? {}) as Record<string, unknown>;
  const endpoints = {
    issuer: requiredDiscoveryField(record, "issuer"),
    authorization_endpoint: requiredDiscoveryField(
      record,
      "authorization_endpoint",
    ),
    token_endpoint: requiredDiscoveryField(record, "token_endpoint"),
  };

  // The pin. Step three posts the client secret to token_endpoint, so a
  // document naming another host would hand it over.
  const expected = new URL(config.issuer_url).origin;
  if (endpoints.issuer !== config.issuer_url) {
    throw new AppError("AUTH_ISSUER_MISMATCH", "the issuer does not match config");
  }
  for (const value of [endpoints.authorization_endpoint, endpoints.token_endpoint]) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new AppError("AUTH_ISSUER_MISMATCH", "an endpoint is not a URL");
    }
    if (parsed.protocol !== "https:" || parsed.origin !== expected) {
      throw new AppError("AUTH_ISSUER_MISMATCH", "an endpoint is off-origin");
    }
  }
  return endpoints;
}

export function startLogin(
  config: Config,
  endpoints: Endpoints,
  redirectUri: string,
  now: Date,
): { redirectUrl: string; setCookie: string } {
  const state = newSecret(32);
  const nonce = newSecret(32);
  const codeVerifier = newSecret(32);
  const challenge = new Bun.CryptoHasher("sha256")
    .update(codeVerifier)
    .digest("base64url");

  const url = new URL(endpoints.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.client_id);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  const value = signPayload(config.session_secret, {
    state,
    nonce,
    code_verifier: codeVerifier,
    exp: toIso(addMs(now, LOGIN_TTL_MS)),
  });
  return {
    redirectUrl: url.href,
    setCookie: `${LOGIN_COOKIE}=${value}; ${attributes(LOGIN_TTL_MS / 1000)}`,
  };
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) return trimmed.slice(name.length + 1);
  }
  return null;
}

function claimsOf(idToken: string): Record<string, unknown> {
  // The signature is deliberately not checked. The token arrived in the body
  // of a direct HTTPS request to token_endpoint, whose origin discover()
  // pinned to the configured issuer, so OIDC Core 3.1.3.7 item 6 lets TLS
  // server validation stand in for the signature. This argument holds only
  // for the code flow; an ID token from a redirect must be verified.
  const parts = idToken.split(".");
  if (parts.length !== 3) {
    throw new AppError("AUTH_TOKEN_INVALID", "the identity token is malformed");
  }
  const json = Buffer.from(parts[1]!, "base64url").toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new AppError("AUTH_TOKEN_INVALID", "the identity token is malformed");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new AppError("AUTH_TOKEN_INVALID", "the identity token is malformed");
  }
  return parsed as Record<string, unknown>;
}

export async function completeLogin(params: {
  config: Config;
  db: Database;
  url: URL;
  cookieHeader: string | null;
  redirectUri: string;
  now: Date;
  fetchImpl?: typeof fetch;
}): Promise<{ user: User; setCookie: string; clearCookie: string }> {
  const { config, db, url, cookieHeader, redirectUri, now } = params;
  const fetchImpl = params.fetchImpl ?? fetch;

  const cookie = readCookie(cookieHeader, LOGIN_COOKIE);
  const attempt = cookie ? verifyPayload(config.session_secret, cookie, now) : null;
  if (!attempt) {
    throw new AppError("AUTH_STATE_MISMATCH", "the login could not be matched");
  }
  const returnedState = url.searchParams.get("state");
  if (!returnedState || returnedState !== attempt.state) {
    throw new AppError("AUTH_STATE_MISMATCH", "the login could not be matched");
  }
  const code = url.searchParams.get("code");
  if (!code) {
    throw new AppError("AUTH_EXCHANGE_FAILED", "the issuer returned no code");
  }

  const endpoints = await discover(config, fetchImpl);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: config.client_id,
    client_secret: config.client_secret,
    code_verifier: String(attempt.code_verifier),
  });

  let payload: Record<string, unknown>;
  try {
    const response = await fetchImpl(endpoints.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!response.ok) {
      throw new AppError("AUTH_EXCHANGE_FAILED", "the code was not accepted");
    }
    payload = (await response.json()) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("AUTH_EXCHANGE_FAILED", "the code was not accepted");
  }

  const idToken = payload.id_token;
  if (typeof idToken !== "string") {
    throw new AppError("AUTH_TOKEN_INVALID", "the response carried no identity");
  }
  const claims = claimsOf(idToken);

  // The five claim checks, in the order of the spec table. Each row names the
  // claim, the rule it must satisfy, and the error a violation carries.
  const claimRules: {
    claim: string;
    holds: (value: unknown) => boolean;
    error: "AUTH_ISSUER_MISMATCH" | "AUTH_TOKEN_INVALID" | "AUTH_TOKEN_EXPIRED";
    because: string;
  }[] = [
    {
      claim: "iss",
      holds: (value) => value === config.issuer_url,
      error: "AUTH_ISSUER_MISMATCH",
      because: "the identity names another issuer",
    },
    {
      claim: "aud",
      holds: (value) =>
        value === config.client_id ||
        (Array.isArray(value) && value.includes(config.client_id)),
      error: "AUTH_TOKEN_INVALID",
      because: "the identity is for another client",
    },
    {
      claim: "exp",
      holds: (value) =>
        typeof value === "number" && value * 1000 > now.getTime(),
      error: "AUTH_TOKEN_EXPIRED",
      because: "the identity has expired",
    },
    {
      claim: "nonce",
      holds: (value) => value === attempt.nonce,
      error: "AUTH_TOKEN_INVALID",
      because: "the identity replays another login",
    },
    {
      claim: "sub",
      holds: (value) => typeof value === "string" && value !== "",
      error: "AUTH_TOKEN_INVALID",
      because: "the identity names no subject",
    },
  ];
  for (const rule of claimRules) {
    if (!rule.holds(claims[rule.claim])) {
      throw new AppError(rule.error, rule.because);
    }
  }
  const subject = claims.sub as string;

  const email = typeof claims.email === "string" ? claims.email : null;
  const existing = getUserBySubject(db, subject);
  const user =
    existing ??
    insertUser(db, {
      id: newUserId(),
      subject,
      email,
      created_at: toIso(now),
    });

  const setCookie = `${SESSION_COOKIE}=${signPayload(config.session_secret, {
    user_id: user.id,
    iat: toIso(now),
    exp: toIso(addMs(now, SESSION_TTL_MS)),
  })}; ${attributes(SESSION_TTL_MS / 1000)}`;

  return { user, setCookie, clearCookie: CLEAR_LOGIN_COOKIE };
}

export function createApiToken(
  db: Database,
  userId: UserId,
  name: string,
  now: Date,
): { token: ApiToken; secret: string } {
  const secret = newSecret(32);
  const token = insertApiToken(db, {
    id: newTokenId(),
    user_id: userId,
    name,
    token_hash: sha256Hex(secret),
    created_at: toIso(now),
    last_used_at: null,
  });
  return { token, secret };
}

export function revokeApiToken(db: Database, userId: UserId, id: TokenId): void {
  deleteApiToken(db, userId, id);
}

export async function authenticate(
  request: Request,
  deps: { db: Database; config: Config; now: Date },
): Promise<Principal> {
  const { db, config, now } = deps;
  const header = request.headers.get("authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : null;

  if (bearer) {
    const row = getApiTokenByHash(db, sha256Hex(bearer));
    if (!row) {
      throw new AppError("AUTH_TOKEN_INVALID", "the credential was rejected");
    }
    const user = getUser(db, row.user_id);
    if (!user) {
      throw new AppError("AUTH_TOKEN_INVALID", "the credential was rejected");
    }
    touchApiToken(db, row.user_id, row.id, now);
    return { user, via: "token" };
  }

  const cookie = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (!cookie) {
    throw new AppError("AUTH_REQUIRED", "this route needs a signed-in reader");
  }
  const payload = verifyPayload(config.session_secret, cookie, now);
  if (!payload || typeof payload.user_id !== "string") {
    throw new AppError("AUTH_TOKEN_INVALID", "the credential was rejected");
  }
  let userId: UserId;
  try {
    userId = asUserId(payload.user_id);
  } catch {
    throw new AppError("AUTH_TOKEN_INVALID", "the credential was rejected");
  }
  const user = getUser(db, userId);
  if (!user) {
    throw new AppError("AUTH_TOKEN_INVALID", "the credential was rejected");
  }
  return { user, via: "session" };
}
