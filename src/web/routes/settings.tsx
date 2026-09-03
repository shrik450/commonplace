import { Elysia } from "elysia";

import { AppError } from "../../contracts/errors";
import { asItemId, asTokenId, type UserId } from "../../contracts/ids";
import { parseSettings, type UserSettings } from "../../contracts/settings";
import { authenticate, createApiToken, revokeApiToken } from "../../services/auth";
import type { ApiToken } from "../../contracts/item";
import { getItem } from "../../store/items";
import { listApiTokens } from "../../store/users";
import { updateUserSettings } from "../../store/settings";
import { ErrorPage, page } from "../views/layout";
import { NewTokenPage, RevokeTokenPage, SettingsPage } from "../views/settings";
import { authDeps, preferredLocale, toLogin, userSettings, type WebDeps } from "./deps";

type MessageKey = "VIEW_MISSING_FIELD" | "VIEW_INVALID_VALUE" | "STORE_NOT_FOUND";

const MESSAGES: Record<MessageKey, string> = {
  VIEW_MISSING_FIELD: "Enter a token name so you can identify it later.",
  STORE_NOT_FOUND: "That token is already gone. Nothing else changed.",
  VIEW_INVALID_VALUE: "Choose a valid value for each setting, then submit again.",
};

function messageFor(code: string): string {
  if (code === "VIEW_MISSING_FIELD" || code === "VIEW_INVALID_VALUE" || code === "STORE_NOT_FOUND") {
    return MESSAGES[code];
  }
  return "Return to settings, and try the token action again.";
}

function settingsError(error: AppError, settings: UserSettings): Response {
  return page(
    <ErrorPage
      title="Settings could not be saved"
      message={messageFor(error.code)}
      code={error.code}
      href="/settings"
      linkLabel="Back to settings"
      settings={settings}
    />,
    400,
  );
}

function tokenError(error: AppError, settings: UserSettings): Response {
  return page(
    <ErrorPage
      title="Commonplace could not update the token"
      message={messageFor(error.code)}
      code={error.code}
      href="/settings"
      linkLabel="Back to settings"
      settings={settings}
    />,
    400,
  );
}

function returnTarget(value: string | undefined, userId: UserId, db: WebDeps["db"]): string {
  if (value === undefined || !value.startsWith("/") || value.startsWith("//")) return "/settings";
  let parsed: URL;
  try {
    parsed = new URL(value, "http://commonplace.invalid");
  } catch {
    return "/settings";
  }
  if (parsed.search !== "" || parsed.hash !== "") return "/settings";
  const match = /^\/items\/([^/]+)$/.exec(parsed.pathname);
  if (match === null) return "/settings";
  try {
    const itemId = asItemId(match[1]!);
    return getItem(db, userId, itemId) === null ? "/settings" : `/items/${itemId}`;
  } catch {
    return "/settings";
  }
}

export function settingsRoutes(deps: WebDeps) {
  return new Elysia()
    .get("/settings", async ({ request }) => {
      const principal = await authenticate(request, authDeps(deps)).catch(
        () => null,
      );
      if (principal === null) return toLogin();

      const tokens = listApiTokens(deps.db, principal.user.id);
      return page(
        <SettingsPage tokens={tokens} locale={preferredLocale(request)} settings={userSettings(deps, principal.user.id)} />,
      );
    })
    .post("/settings", async ({ request }) => {
      const principal = await authenticate(request, authDeps(deps)).catch(() => null);
      if (principal === null) return toLogin();
      const fields = new URLSearchParams(await request.text());
      try {
        updateUserSettings(deps.db, parseSettings(principal.user.id, Object.fromEntries(fields)));
      } catch (error) {
        if (error instanceof AppError) return settingsError(error, userSettings(deps, principal.user.id));
        throw error;
      }
      const acceptsJson = request.headers.get("accept")?.includes("application/json") ?? false;
      return acceptsJson
        ? new Response(null, { status: 204 })
        : new Response(null, { status: 303, headers: { location: returnTarget(fields.get("return_to") ?? undefined, principal.user.id, deps.db) } });
    })
    // Show a confirmation page before the POST request revokes the token.
    .get("/settings/tokens/:id/revoke", async ({ request, params }) => {
      const principal = await authenticate(request, authDeps(deps)).catch(
        () => null,
      );
      if (principal === null) return toLogin();

      let token: ApiToken | undefined;
      try {
        const tokenId = asTokenId(params.id);
        token = listApiTokens(deps.db, principal.user.id).find(
          (candidate) => candidate.id === tokenId,
        );
      } catch (error) {
        if (error instanceof AppError) return tokenError(error, userSettings(deps, principal.user.id));
        throw error;
      }
      if (token === undefined) {
        return tokenError(
          new AppError("STORE_NOT_FOUND", "no such token", { id: params.id }),
          userSettings(deps, principal.user.id),
        );
      }
      return page(
        <RevokeTokenPage token={token} locale={preferredLocale(request)} settings={userSettings(deps, principal.user.id)} />,
      );
    })
    .post("/settings/tokens", async ({ request }) => {
      const principal = await authenticate(request, authDeps(deps)).catch(
        () => null,
      );
      if (principal === null) return toLogin();

      const fields = new URLSearchParams(await request.text());
      const name = (fields.get("name") ?? "").trim();
      if (name === "") {
        return tokenError(
          new AppError("VIEW_MISSING_FIELD", "a token needs a name", { field: "name" }),
          userSettings(deps, principal.user.id),
        );
      }

      // Return the secret only in this response. The store retains its hash.
      const { secret } = createApiToken(
        deps.db,
        principal.user.id,
        name,
        deps.now(),
      );
      return page(<NewTokenPage name={name} secret={secret} settings={userSettings(deps, principal.user.id)} />);
    })
    .post("/settings/tokens/:id/delete", async ({ request, params }) => {
      const principal = await authenticate(request, authDeps(deps)).catch(
        () => null,
      );
      if (principal === null) return toLogin();

      try {
        revokeApiToken(deps.db, principal.user.id, asTokenId(params.id));
      } catch (error) {
        if (error instanceof AppError) return tokenError(error, userSettings(deps, principal.user.id));
        throw error;
      }
      return new Response(null, {
        status: 303,
        headers: { location: "/settings" },
      });
    });
}
