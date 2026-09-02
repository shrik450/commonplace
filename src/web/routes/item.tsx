import { Elysia } from "elysia";

import { AppError } from "../../contracts/errors";
import { asItemId } from "../../contracts/ids";
import type { ItemId } from "../../contracts/ids";
import { authenticate } from "../../services/auth";
import { captureFile, loadTranscript, readerPage } from "../../services/library";
import { ErrorPage, page } from "../views/layout";
import { ReaderPageView } from "../views/reader";
import { authDeps, libraryDeps, preferredLocale, toLogin, type WebDeps } from "./deps";

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
      title="We cannot find that page"
      message="Nothing in your library has that address. Someone may have deleted it, or the link may be out of date."
    />,
    404,
  );
}

function badRequest(): Response {
  return page(
    <ErrorPage
      title="That address is not an item"
      message="An item address ends in an identifier, and this one does not. Open your library and pick the page again."
    />,
    400,
  );
}

function missing(error: unknown): boolean {
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
        if (missing(error)) return notFound();
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
        if (missing(error)) return notFound();
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
            // The capture view is a static archive of someone else's
            // page, so it runs with no script at all. Invariant 8 reads
            // this handler, so the policy stays here rather than in a
            // constant a second route could borrow.
            "content-security-policy":
              "default-src 'none'; img-src data: https: http:;" +
              " style-src 'unsafe-inline'; script-src 'none'",
          },
        });
      } catch (error) {
        if (missing(error)) return notFound();
        throw error;
      }
    });
}
