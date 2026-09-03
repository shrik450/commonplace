import { Database } from "bun:sqlite";
import { createHmac, timingSafeEqual } from "node:crypto";

import { addMs, isBefore, parseIso, toIso } from "../contracts/clock";
import type { Config } from "../contracts/config";
import { AppError } from "../contracts/errors";
import {
  isJsonObject,
  isNumberValue,
  isStringValue,
  parseJsonValue,
  type JsonObject,
  type JsonValue,
} from "../contracts/item";
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

export type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
export type Principal = { user: User; via: "session" | "token" };
export type Endpoints = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
};
export type LoginStart = { redirectUrl: string; setCookie: string };
export type ApiTokenResult = { token: ApiToken; secret: string };

function attributes(maxAgeSeconds: number): string {
  return `Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

// A zero `Max-Age` instructs the browser to delete the cookie.
const CLEAR_COOKIE_MAX_AGE_SECONDS = 0;

// Clear the login cookie after every callback so an expired attempt can't be
// reused.
export const CLEAR_LOGIN_COOKIE = `${LOGIN_COOKIE}=; ${attributes(CLEAR_COOKIE_MAX_AGE_SECONDS)}`;

function stringField(record: JsonObject, name: string): string | null {
  const value = record[name];
  return isStringValue(value) ? value : null;
}

function requiredDiscoveryField(record: JsonObject, name: string): string {
  const value = stringField(record, name);
  if (value === null || value === "") {
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
  payload: JsonObject,
): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function verifyPayload(
  secret: string,
  value: string,
  now: Date,
): JsonObject | null {
  const dot = value.indexOf(".");
  if (dot <= 0 || dot === value.length - 1) return null;
  const body = value.slice(0, dot);
  const signature = value.slice(dot + 1);

  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(signature, "base64url");
  // `timingSafeEqual` throws when the buffers have different lengths.
  if (given.length !== expected.length) return null;
  if (!timingSafeEqual(given, expected)) return null;

  let payload: JsonValue;
  try {
    payload = parseJsonValue(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isJsonObject(payload)) return null;

  const exp = stringField(payload, "exp");
  if (exp === null) return null;
  let expiresAt: Date;
  try {
    expiresAt = parseIso(exp);
  } catch {
    return null;
  }
  if (!isBefore(now, expiresAt)) return null;
  return payload;
}

export async function discover(
  config: Config,
  fetchImpl: FetchImplementation = fetch,
): Promise<Endpoints> {
  const url = `${config.issuer_url}/.well-known/openid-configuration`;
  let document: JsonValue;
  try {
    const response = await fetchImpl(url);
    if (!response.ok) {
      throw new AppError(
        "AUTH_DISCOVERY_FAILED",
        "the identity provider returned an error",
      );
    }
    document = parseJsonValue(await response.text());
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      "AUTH_DISCOVERY_FAILED",
      "the identity provider request failed",
    );
  }

  if (!isJsonObject(document)) {
    throw new AppError(
      "AUTH_ISSUER_MISMATCH",
      "the discovery document is not a JSON object",
    );
  }
  const record = document;
  const endpoints = {
    issuer: requiredDiscoveryField(record, "issuer"),
    authorization_endpoint: requiredDiscoveryField(
      record,
      "authorization_endpoint",
    ),
    token_endpoint: requiredDiscoveryField(record, "token_endpoint"),
  };

  // Require same-origin HTTPS endpoints before sending the client secret.
  const expected = new URL(config.issuer_url).origin;
  if (endpoints.issuer !== config.issuer_url) {
    throw new AppError(
      "AUTH_ISSUER_MISMATCH",
      "the discovery issuer doesn't match issuer_url",
    );
  }
  for (const value of [endpoints.authorization_endpoint, endpoints.token_endpoint]) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new AppError(
        "AUTH_ISSUER_MISMATCH",
        "the discovery document contains an invalid endpoint URL",
      );
    }
    if (parsed.protocol !== "https:" || parsed.origin !== expected) {
      throw new AppError(
        "AUTH_ISSUER_MISMATCH",
        "a discovery endpoint isn't same-origin HTTPS",
      );
    }
  }
  return endpoints;
}

export function startLogin(
  config: Config,
  endpoints: Endpoints,
  redirectUri: string,
  now: Date,
): LoginStart {
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

function claimsOf(idToken: string): JsonObject {
  // Don't verify the signature for this authorization code flow. OpenID
  // Connect Core 3.1.3.7, item 6, permits TLS server validation when the ID
  // token comes directly from the pinned token endpoint. Tokens received from
  // another channel require signature verification.
  const parts = idToken.split(".");
  if (parts.length !== 3) {
    throw new AppError("AUTH_TOKEN_INVALID", "the identity token is malformed");
  }
  const json = Buffer.from(parts[1]!, "base64url").toString("utf8");
  let parsed: JsonValue;
  try {
    parsed = parseJsonValue(json);
  } catch {
    throw new AppError("AUTH_TOKEN_INVALID", "the identity token is malformed");
  }
  if (!isJsonObject(parsed)) {
    throw new AppError("AUTH_TOKEN_INVALID", "the identity token is malformed");
  }
  return parsed;
}

export async function completeLogin(params: {
  config: Config;
  db: Database;
  url: URL;
  cookieHeader: string | null;
  redirectUri: string;
  now: Date;
  fetchImpl?: FetchImplementation;
}): Promise<{ user: User; setCookie: string; clearCookie: string }> {
  const { config, db, url, cookieHeader, redirectUri, now } = params;
  const fetchImpl = params.fetchImpl ?? fetch;

  const cookie = readCookie(cookieHeader, LOGIN_COOKIE);
  const attempt = cookie ? verifyPayload(config.session_secret, cookie, now) : null;
  if (!attempt) {
    throw new AppError("AUTH_STATE_MISMATCH", "the login could not be matched");
  }
  const returnedState = url.searchParams.get("state");
  const expectedState = stringField(attempt, "state");
  const expectedNonce = stringField(attempt, "nonce");
  const codeVerifier = stringField(attempt, "code_verifier");
  if (
    returnedState === null ||
    expectedState === null ||
    expectedNonce === null ||
    codeVerifier === null ||
    returnedState !== expectedState
  ) {
    throw new AppError("AUTH_STATE_MISMATCH", "the login could not be matched");
  }
  const code = url.searchParams.get("code");
  if (!code) {
    throw new AppError(
      "AUTH_EXCHANGE_FAILED",
      "the callback contains no authorization code",
    );
  }

  const endpoints = await discover(config, fetchImpl);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: config.client_id,
    client_secret: config.client_secret,
    code_verifier: codeVerifier,
  });

  let payload: JsonValue;
  try {
    const response = await fetchImpl(endpoints.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!response.ok) {
      throw new AppError(
        "AUTH_EXCHANGE_FAILED",
        "the identity provider rejected the authorization code",
      );
    }
    payload = parseJsonValue(await response.text());
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("AUTH_EXCHANGE_FAILED", "the token request failed");
  }

  if (!isJsonObject(payload)) {
    throw new AppError("AUTH_TOKEN_INVALID", "the token response is not a JSON object");
  }
  const idToken = stringField(payload, "id_token");
  if (idToken === null) {
    throw new AppError("AUTH_TOKEN_INVALID", "the token response contains no ID token");
  }
  const claims = claimsOf(idToken);

  // Validate the required OpenID Connect claims in specification order.
  const claimRules: {
    claim: string;
    holds: (value: JsonValue | undefined) => boolean;
    error: "AUTH_ISSUER_MISMATCH" | "AUTH_TOKEN_INVALID" | "AUTH_TOKEN_EXPIRED";
    because: string;
  }[] = [
    {
      claim: "iss",
      holds: (value) => value === config.issuer_url,
      error: "AUTH_ISSUER_MISMATCH",
      because: "the ID token names a different issuer",
    },
    {
      claim: "aud",
      holds: (value) =>
        value === config.client_id ||
        (Array.isArray(value) && value.includes(config.client_id)),
      error: "AUTH_TOKEN_INVALID",
      because: "the ID token has a different audience",
    },
    {
      claim: "exp",
      holds: (value) =>
        isNumberValue(value) && value * 1000 > now.getTime(),
      error: "AUTH_TOKEN_EXPIRED",
      because: "the ID token has expired",
    },
    {
      claim: "nonce",
      holds: (value) => value === expectedNonce,
      error: "AUTH_TOKEN_INVALID",
      because: "the ID token nonce doesn't match the login request",
    },
    {
      claim: "sub",
      holds: (value) => isStringValue(value) && value !== "",
      error: "AUTH_TOKEN_INVALID",
      because: "the ID token has no subject",
    },
  ];
  for (const rule of claimRules) {
    if (!rule.holds(claims[rule.claim])) {
      throw new AppError(rule.error, rule.because);
    }
  }
  const subject = stringField(claims, "sub");
  if (subject === null) {
    throw new AppError("AUTH_TOKEN_INVALID", "the ID token has no subject");
  }

  const email = stringField(claims, "email");
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
): ApiTokenResult {
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
  const userIdValue = payload ? stringField(payload, "user_id") : null;
  if (userIdValue === null) {
    throw new AppError("AUTH_TOKEN_INVALID", "the credential was rejected");
  }
  let userId: UserId;
  try {
    userId = asUserId(userIdValue);
  } catch {
    throw new AppError("AUTH_TOKEN_INVALID", "the credential was rejected");
  }
  const user = getUser(db, userId);
  if (!user) {
    throw new AppError("AUTH_TOKEN_INVALID", "the credential was rejected");
  }
  return { user, via: "session" };
}
