import { Elysia } from "elysia";

import { asRequestId, type RequestId } from "../../contracts/ids";
import type { FetchRequest } from "../../contracts/item";
import { getSaveRequest } from "../../services/library";
import { authenticate } from "../../services/auth";
import { SaveStatusPage } from "../views/save";
import { ErrorPage, page } from "../views/layout";
import {
  authDeps,
  libraryDeps,
  toLogin,
  type WebDeps,
} from "./deps";

function readRequestId(raw: string): RequestId | null {
  try {
    return asRequestId(raw);
  } catch {
    return null;
  }
}

function notFound(): Response {
  return page(
    <ErrorPage
      title="Commonplace cannot find that save"
      message="Your library has no save at this address. The save may have been removed, or the link may be outdated."
    />,
    404,
  );
}

function badRequest(): Response {
  return page(
    <ErrorPage
      title="That save address is invalid"
      message="A valid save address ends with a save request ID. Open your library, and select the save again."
    />,
    400,
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
  return new Elysia().get(
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
        return apiClient ? apiError("STORE_INVALID_PATH", 400) : badRequest();
      }

      const save = getSaveRequest(
        libraryDeps(deps),
        principal.user.id,
        requestId,
      );
      if (save === null) {
        return apiClient ? apiError("STORE_NOT_FOUND", 404) : notFound();
      }

      if (apiClient) return apiStatus(save);

      if (save.state === "done") {
        if (save.item_id === null) return notFound();
        return new Response(null, {
          status: 303,
          headers: { location: `/items/${save.item_id}` },
        });
      }

      const response = page(<SaveStatusPage request={save} />);
      response.headers.set("cache-control", "no-store");
      return response;
    },
  );
}
