import { Elysia } from "elysia";

import { AppError } from "../../contracts/errors";
import { asTokenId } from "../../contracts/ids";
import { authenticate, createApiToken, revokeApiToken } from "../../services/auth";
import { listApiTokens } from "../../store/users";
import { page } from "../views/layout";
import { NewTokenPage, SettingsPage } from "../views/settings";
import { authDeps, toLogin, type WebDeps } from "./deps";

function badRequest(error: AppError): Response {
  return new Response(error.code, { status: 400 });
}

export function settingsRoutes(deps: WebDeps) {
  return new Elysia()
    .get("/settings", async ({ request }) => {
      const principal = await authenticate(request, authDeps(deps)).catch(
        () => null,
      );
      if (principal === null) return toLogin();

      const tokens = listApiTokens(deps.db, principal.user.id);
      return page(<SettingsPage tokens={tokens} />);
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
