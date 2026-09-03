import { Elysia } from "elysia";

import { AppError } from "../../contracts/errors";
import { asItemId } from "../../contracts/ids";
import type { ItemId } from "../../contracts/ids";
import { authenticate } from "../../services/auth";
import { captureFile, loadTranscript, readerPage } from "../../services/library";
import { ErrorPage, page } from "../views/layout";
import { ReaderPageView } from "../views/reader";
import {
  authDeps,
  libraryDeps,
  preferredLocale,
  toLogin,
  type WebDeps,
} from "./deps";

function readItemId(raw: string): ItemId | null {
  try {
    return asItemId(raw);
  } catch {
    return null;
  }
}

function notFound(): Response {
  return page(
    <ErrorPage
      title="Commonplace cannot find that page"
      message="Your library has no item at this address. The item may have been deleted, or the link may be outdated."
    />,
    404,
  );
}

function badRequest(): Response {
  return page(
    <ErrorPage
      title="That item address is invalid"
      message="A valid item address ends with an item ID. Open your library, and select the page again."
    />,
    400,
  );
}

function missing(error: Error): boolean {
  return error instanceof AppError && error.code === "STORE_NOT_FOUND";
}

export function itemRoutes(deps: WebDeps) {
  return new Elysia()
    .get("/items/:id", async ({ request, params }) => {
      const principal = await authenticate(request, authDeps(deps)).catch(
        () => null,
      );
      if (principal === null) return toLogin();

      const itemId = readItemId(params.id);
      if (itemId === null) return badRequest();

      try {
        const view = await readerPage(
          libraryDeps(deps),
          principal.user.id,
          itemId,
        );
        return page(
          <ReaderPageView
            item={view.item}
            html={view.html}
            annotations={view.annotations}
            locale={preferredLocale(request)}
          />,
        );
      } catch (error) {
        if (error instanceof Error && missing(error)) return notFound();
        throw error;
      }
    })
    .get("/items/:id/raw", async ({ request, params }) => {
      const principal = await authenticate(request, authDeps(deps)).catch(
        () => null,
      );
      if (principal === null) return toLogin();

      const itemId = readItemId(params.id);
      if (itemId === null) return badRequest();

      try {
        const loaded = await loadTranscript(
          libraryDeps(deps),
          principal.user.id,
          itemId,
        );
        return new Response(loaded.transcript, {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      } catch (error) {
        if (error instanceof Error && missing(error)) return notFound();
        throw error;
      }
    })
    .get("/items/:id/capture", async ({ request, params }) => {
      const principal = await authenticate(request, authDeps(deps)).catch(
        () => null,
      );
      if (principal === null) return toLogin();

      const itemId = readItemId(params.id);
      if (itemId === null) return badRequest();

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
              "default-src 'none'; img-src data: https: http:;" +
              " style-src 'unsafe-inline'; script-src 'none'",
          },
        });
      } catch (error) {
        if (error instanceof Error && missing(error)) return notFound();
        throw error;
      }
    });
}
