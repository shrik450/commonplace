import { Elysia } from "elysia";

import { asRequestId, type RequestId } from "../../contracts/ids";
import type { FetchRequest } from "../../contracts/item";
import { getSaveRequest } from "../../services/library";
import { authenticate } from "../../services/auth";
import { removeSave, saveRemoval, type SaveRemoval } from "../../services/removal";
import { RemoveSavePage } from "../views/removal";
import { SavePage, SaveStatusPage } from "../views/save";
import { ErrorPage, page, type PageContext } from "../views/layout";
import { authDeps, libraryDeps, pageContext, toLogin, type WebDeps } from "./deps";
import { errorResponse, seeOther } from "./errors";

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

// Why a save can't be removed, and where to go instead.
function kept(context: PageContext, removal: Exclude<SaveRemoval, { kind: "removable" }>): Response {
  if (removal.kind === "saved") {
    return page(
      <ErrorPage
        context={context}
        title="This save has finished"
        message="The page is in your library now. To take it out, remove the page itself."
        href={`/items/${removal.itemId}/delete`}
        linkLabel="Remove page…"
      />,
      409,
    );
  }
  return page(
    <ErrorPage
      context={context}
      title="This save is refreshing a page in your library"
      message="Stopping it partway would leave that page half replaced. Wait a minute for it to finish, then remove the page if you don’t want it."
      href={`/items/${removal.itemId}`}
      linkLabel="Open the page"
    />,
    409,
  );
}

export function saveRoutes(deps: WebDeps) {
  const signedIn = async (request: Request) => {
    const principal = await authenticate(request, authDeps(deps)).catch(() => null);
    if (principal === null) return null;
    return { userId: principal.user.id, context: pageContext(deps, principal.user.id, request) };
  };


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

      const removable = saveRemoval(libraryDeps(deps), save).kind === "removable";
      const response = page(<SaveStatusPage request={save} removable={removable} context={pageContext(deps, principal.user.id, request)} />);
      response.headers.set("cache-control", "no-store");
      return response;
    },
  )
    .get("/saves/:requestId/delete", async ({ request, params }) => {
      const session = await signedIn(request);
      if (session === null) return toLogin();
      const requestId = readRequestId(params.requestId);
      if (requestId === null) return badRequest(session.context);
      const save = getSaveRequest(libraryDeps(deps), session.userId, requestId);
      if (save === null) return notFound(session.context);
      const removal = saveRemoval(libraryDeps(deps), save);
      if (removal.kind !== "removable") return kept(session.context, removal);
      return page(<RemoveSavePage save={save} context={session.context} />);
    })
    .post("/saves/:requestId/delete", async ({ request, params }) => {
      const session = await signedIn(request);
      if (session === null) return toLogin();
      const requestId = readRequestId(params.requestId);
      if (requestId === null) return badRequest(session.context);
      const removal = removeSave(libraryDeps(deps), session.userId, requestId);
      if (removal === null) return notFound(session.context);
      if (removal.kind !== "removable") return kept(session.context, removal);
      return seeOther("/library");
    });
}
