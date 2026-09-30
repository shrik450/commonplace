import { Elysia } from "elysia";

import { asRequestId, type RequestId } from "../../contracts/ids";
import type { FetchRequest } from "../../contracts/item";
import { getSaveRequest } from "../../services/library";
import { authenticate } from "../../services/auth";
import { SavePage, SaveStatusPage } from "../views/save";
import { page, type PageContext } from "../views/layout";
import { authDeps, libraryDeps, pageContext, toLogin, type WebDeps } from "./deps";
import { errorResponse } from "./errors";

function readRequestId(raw: string): RequestId | null {
  try {
    return asRequestId(raw);
  } catch {
    return null;
  }
}

function notFound(context: PageContext): Response {
  return errorResponse(
    context,
    404,
    "Commonplace cannot find that save",
    "Your library has no save at this address. The save may have been removed, or the link may be outdated.",
  );
}

function badRequest(context: PageContext): Response {
  return errorResponse(
    context,
    400,
    "That save address is invalid",
    "A valid save address ends with a save request ID. Open your library, and select the save again.",
  );
}

function isBearerClient(request: Request): boolean {
  return request.headers.get("authorization")?.startsWith("Bearer ") ?? false;
}

function apiError(code: string, status: number): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function apiStatus(save: FetchRequest): Response {
  return new Response(
    JSON.stringify({
      request_id: save.id,
      state: save.state,
      attempts: save.attempts,
      error_code: save.error_code,
      item_id: save.item_id,
    }),
    {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json",
      },
    },
  );
}

export function saveRoutes(deps: WebDeps) {
  return new Elysia()
    .get("/save", async ({ request }) => {
      const principal = await authenticate(request, authDeps(deps)).catch(() => null);
      if (principal === null) return toLogin();
      return page(<SavePage context={pageContext(deps, principal.user.id, request)} />);
    })
    .get(
    "/saves/:requestId",
    async ({ request, params }) => {
      const apiClient = isBearerClient(request);
      const principal = await authenticate(request, authDeps(deps)).catch(
        () => null,
      );
      if (principal === null) {
        return apiClient ? apiError("AUTH_TOKEN_INVALID", 401) : toLogin();
      }

      const requestId = readRequestId(params.requestId);
      if (requestId === null) {
        return apiClient ? apiError("STORE_INVALID_PATH", 400) : badRequest(pageContext(deps, principal.user.id, request));
      }

      const save = getSaveRequest(
        libraryDeps(deps),
        principal.user.id,
        requestId,
      );
      if (save === null) {
        return apiClient ? apiError("STORE_NOT_FOUND", 404) : notFound(pageContext(deps, principal.user.id, request));
      }

      if (apiClient) return apiStatus(save);

      if (save.state === "done") {
        if (save.item_id === null) return notFound(pageContext(deps, principal.user.id, request));
        return new Response(null, {
          status: 303,
          headers: { location: `/items/${save.item_id}` },
        });
      }

      const response = page(<SaveStatusPage request={save} context={pageContext(deps, principal.user.id, request)} />);
      response.headers.set("cache-control", "no-store");
      return response;
    },
  );
}
