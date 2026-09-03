import { Elysia } from "elysia";

import { AppError } from "../../contracts/errors";
import { asItemId } from "../../contracts/ids";
import type { ItemId } from "../../contracts/ids";
import { authenticate } from "../../services/auth";
import { captureFile, readerPage } from "../../services/library";
import type { ProjectionMode } from "../../core/project";
import { ErrorPage, page } from "../views/layout";
import { ReaderPageView } from "../views/reader";
import {
  authDeps,
  libraryDeps,
  preferredLocale,
  toLogin,
  userSettings,
  type WebDeps,
} from "./deps";

function readItemId(raw: string): ItemId | null {
  try {
    return asItemId(raw);
  } catch {
    return null;
  }
}

function notFound(settings: ReturnType<typeof userSettings>): Response {
  return page(
    <ErrorPage
      title="Commonplace cannot find that page"
      message="Your library has no item at this address. The item may have been deleted, or the link may be outdated."
      settings={settings}
    />,
    404,
  );
}

function badRequest(settings: ReturnType<typeof userSettings>): Response {
  return page(
    <ErrorPage
      title="That item address is invalid"
      message="A valid item address ends with an item ID. Open your library, and select the page again."
      settings={settings}
    />,
    400,
  );
}

function missing(error: Error): boolean {
  return error instanceof AppError && error.code === "STORE_NOT_FOUND";
}

async function itemPageResponse(
  request: Request,
  rawItemId: string,
  deps: WebDeps,
  mode: ProjectionMode,
): Promise<Response> {
  const principal = await authenticate(request, authDeps(deps)).catch(() => null);
  if (principal === null) return toLogin();

  const itemId = readItemId(rawItemId);
  if (itemId === null) return badRequest(userSettings(deps, principal.user.id));

  try {
    const view = await readerPage(
      libraryDeps(deps),
      principal.user.id,
      itemId,
      mode,
    );
    return page(
      <ReaderPageView
        item={view.item}
        html={view.html}
        annotations={view.annotations}
        locale={preferredLocale(request)}
        settings={userSettings(deps, principal.user.id)}
        interactive={mode === "reader"}
      />,
    );
  } catch (error) {
    if (error instanceof Error && missing(error)) return notFound(userSettings(deps, principal.user.id));
    throw error;
  }
}

export function itemRoutes(deps: WebDeps) {
  return new Elysia()
    .get("/items/:id", ({ request, params }) =>
      itemPageResponse(request, params.id, deps, "reader"),
    )
    .get("/items/:id/raw", ({ request, params }) =>
      itemPageResponse(request, params.id, deps, "structured"),
    )
    .get("/items/:id/capture", async ({ request, params }) => {
      const principal = await authenticate(request, authDeps(deps)).catch(
        () => null,
      );
      if (principal === null) return toLogin();

      const itemId = readItemId(params.id);
      if (itemId === null) return badRequest(userSettings(deps, principal.user.id));

      try {
        const html = await captureFile(
          libraryDeps(deps),
          principal.user.id,
          itemId,
        );
        return new Response(html, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy":
              "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:;" +
              " font-src data:; script-src 'none'; connect-src 'none';" +
              " frame-src 'none'; object-src 'none'; form-action 'none';" +
              " base-uri 'none'; frame-ancestors 'none'",
          },
        });
      } catch (error) {
        if (error instanceof Error && missing(error)) return notFound(userSettings(deps, principal.user.id));
        throw error;
      }
    });
}
