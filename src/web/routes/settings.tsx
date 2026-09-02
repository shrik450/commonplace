import { Elysia } from "elysia";

import { AppError } from "../../contracts/errors";
import { asTokenId } from "../../contracts/ids";
import { authenticate, createApiToken, revokeApiToken } from "../../services/auth";
import type { ApiToken } from "../../contracts/item";
import { listApiTokens } from "../../store/users";
import { ErrorPage, page } from "../views/layout";
import { NewTokenPage, RevokeTokenPage, SettingsPage } from "../views/settings";
import { authDeps, preferredLocale, toLogin, type WebDeps } from "./deps";

const MESSAGES: Record<string, string> = {
  VIEW_MISSING_FIELD: "Give the token a name first, so you can tell it apart from the others later.",
  STORE_NOT_FOUND: "That token is already gone. Nothing else changed.",
};

function badRequest(error: AppError): Response {
  return page(
    <ErrorPage
      title="That did not work"
      message={MESSAGES[error.code] ?? "Commonplace could not do that. Go back to settings and try again."}
      code={error.code}
      href="/settings"
      linkLabel="Back to settings"
    />,
    400,
  );
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
        <SettingsPage tokens={tokens} locale={preferredLocale(request)} />,
      );
    })
    // Revoking cannot be undone, so the button on the settings page links
    // here and the POST below only runs after this page asks.
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
        if (error instanceof AppError) return badRequest(error);
        throw error;
      }
      if (token === undefined) {
        return badRequest(
          new AppError("STORE_NOT_FOUND", "no such token", { id: params.id }),
        );
      }
      return page(
        <RevokeTokenPage token={token} locale={preferredLocale(request)} />,
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
        return badRequest(
          new AppError("VIEW_MISSING_FIELD", "a token needs a name", {
            field: "name",
          }),
        );
      }

      // The secret is handed back once, in this response. The store keeps
      // only its hash, so no later page can show it again.
      const { secret } = createApiToken(
        deps.db,
        principal.user.id,
        name,
        deps.now(),
      );
      return page(<NewTokenPage name={name} secret={secret} />);
    })
    .post("/settings/tokens/:id/delete", async ({ request, params }) => {
      const principal = await authenticate(request, authDeps(deps)).catch(
        () => null,
      );
      if (principal === null) return toLogin();

      try {
        revokeApiToken(deps.db, principal.user.id, asTokenId(params.id));
      } catch (error) {
        if (error instanceof AppError) return badRequest(error);
        throw error;
      }
      return new Response(null, {
        status: 303,
        headers: { location: "/settings" },
      });
    });
}
