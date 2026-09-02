import { Elysia } from "elysia";

import { AppError } from "../../contracts/errors";
import {
  CLEAR_LOGIN_COOKIE,
  SESSION_COOKIE,
  completeLogin,
  discover,
  startLogin,
} from "../../services/auth";
import type { WebDeps } from "./deps";

const CLEAR_SESSION_COOKIE = `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

function redirectUriFor(request: Request): string {
  return new URL("/login/callback", request.url).toString();
}

function seeOther(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}

export function authRoutes(deps: WebDeps) {
  return new Elysia()
    .get("/login", async ({ request }) => {
      try {
        const endpoints = await discover(deps.config);
        const { redirectUrl, setCookie } = startLogin(
          deps.config,
          endpoints,
          redirectUriFor(request),
          deps.now(),
        );
        return seeOther(redirectUrl, [setCookie]);
      } catch (error) {
        const code = error instanceof AppError ? error.code : "AUTH_REQUIRED";
        return new Response(`login is unavailable: ${code}`, { status: 503 });
      }
    })
    .get("/login/callback", async ({ request }) => {
      try {
        const { setCookie, clearCookie } = await completeLogin({
          config: deps.config,
          db: deps.db,
          url: new URL(request.url),
          cookieHeader: request.headers.get("cookie"),
          redirectUri: redirectUriFor(request),
          now: deps.now(),
        });
        return seeOther("/library", [setCookie, clearCookie]);
      } catch (error) {
        const code = error instanceof AppError ? error.code : "AUTH_REQUIRED";
        return new Response(`the login failed: ${code}`, {
          status: 401,
          headers: { "set-cookie": CLEAR_LOGIN_COOKIE },
        });
      }
    });
}

// Signing out needs no reader: a cookie that no longer verifies still deserves
// to be cleared, so this route drops the cookie and sends the browser home.
export function logoutRoute() {
  return new Elysia().get("/logout", () =>
    seeOther("/", [CLEAR_SESSION_COOKIE]),
  );
}
