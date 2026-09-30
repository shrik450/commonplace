import { Elysia } from "elysia";

import { parseClipSelection, parseNote } from "../../contracts/clipping";
import { parsePagePosition } from "../../contracts/cursor";
import { AppError } from "../../contracts/errors";
import { asAnnotationId, asItemId, type AnnotationId, type ItemId } from "../../contracts/ids";
import type { Item } from "../../contracts/item";
import { authenticate } from "../../services/auth";
import {
  addClipping,
  commonplaceBook,
  editNote,
  getClipping,
  removeClipping,
  type BookFilter,
} from "../../services/clippings";
import { findItem } from "../../services/library";
import { BookPage, ClippingPage, RemoveClippingPage } from "../views/clippings";
import { page, type PageContext } from "../views/layout";
import { authDeps, libraryDeps, pageContext, toLogin, type WebDeps } from "./deps";
import { errorResponse, seeOther } from "./errors";

const SEED_LIMIT = 2 ** 31;

function invalidFilter(value: string): AppError {
  return new AppError("VIEW_INVALID_VALUE", "the book link names an unknown view", { value });
}

// Reads the book's filters from a query string. Unknown values are errors, so
// a mistyped link says so instead of quietly showing another view.
function parseBookFilter(params: URLSearchParams): BookFilter {
  const item = params.get("item");
  const notes = params.get("notes");
  const order = params.get("order");
  if (notes !== null && notes !== "1") throw invalidFilter(notes);
  let itemId: ItemId | null = null;
  if (item !== null) {
    try {
      itemId = asItemId(item);
    } catch {
      throw invalidFilter(item);
    }
  }
  if (order === null || order === "by-page") {
    return { notesOnly: notes === "1", itemId, order: { kind: "by-page" } };
  }
  if (order !== "shuffle") throw invalidFilter(order);
  const seed = Number(params.get("seed") ?? "");
  if (!Number.isSafeInteger(seed) || seed < 0 || seed >= SEED_LIMIT) throw invalidFilter(params.get("seed") ?? "");
  return { notesOnly: notes === "1", itemId, order: { kind: "shuffle", seed } };
}

function readAnnotationId(raw: string): AnnotationId | null {
  try {
    return asAnnotationId(raw);
  } catch {
    return null;
  }
}

function readItemId(raw: string): ItemId | null {
  try {
    return asItemId(raw);
  } catch {
    return null;
  }
}

function missing(error: Error): boolean {
  return error instanceof AppError && error.code === "STORE_NOT_FOUND";
}

function badClippingLink(context: PageContext): Response {
  return errorResponse(
    context,
    400,
    "That clipping address is invalid",
    "A valid clipping address ends with a clipping ID. Open your commonplace book, and choose the clipping again.",
  );
}

function clippingNotFound(context: PageContext): Response {
  return errorResponse(
    context,
    404,
    "Commonplace cannot find that clipping",
    "Your commonplace book has no clipping at this address. It may have been removed.",
  );
}

function pageNotFound(context: PageContext): Response {
  return errorResponse(
    context,
    404,
    "Commonplace cannot find that page",
    "Your library has no item at this address. The item may have been deleted, or the link may be outdated.",
  );
}

export function clippingRoutes(deps: WebDeps) {
  const signedIn = async (request: Request) => {
    const principal = await authenticate(request, authDeps(deps)).catch(() => null);
    if (principal === null) return null;
    return { userId: principal.user.id, context: pageContext(deps, principal.user.id, request) };
  };

  return new Elysia()
    .get("/clippings", async ({ request }) => {
      const session = await signedIn(request);
      if (session === null) return toLogin();
      const params = new URL(request.url).searchParams;
      let filter: BookFilter;
      let position: ReturnType<typeof parsePagePosition>;
      try {
        filter = parseBookFilter(params);
        position = parsePagePosition(params);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        return errorResponse(
          session.context,
          400,
          "That book link is broken",
          "The link asks for a view of your commonplace book that doesn't exist. Open the book from the Clippings tab.",
          error.code,
        );
      }
      let focus: Item | null = null;
      if (filter.itemId !== null) {
        focus = findItem(libraryDeps(deps), session.userId, filter.itemId);
        if (focus === null) return pageNotFound(session.context);
      }
      const book = commonplaceBook(libraryDeps(deps), session.userId, filter, position);
      return page(
        <BookPage
          book={book}
          filter={filter}
          focus={focus}
          seed={Math.floor(Math.random() * SEED_LIMIT)}
          context={session.context}
        />,
      );
    })
    .post("/items/:id/clippings", async ({ request, params }) => {
      const session = await signedIn(request);
      if (session === null) return toLogin();
      const itemId = readItemId(params.id);
      if (itemId === null) {
        return errorResponse(session.context, 400, "That item address is invalid", "Open your library, and select the page again.");
      }
      const fields = new URLSearchParams(await request.text());
      try {
        const selection = parseClipSelection(fields);
        const note = parseNote(fields.get("note"));
        const created = await addClipping(libraryDeps(deps), session.userId, itemId, selection, note, deps.now());
        return seeOther(`/items/${itemId}#b${created.block_index}`);
      } catch (error) {
        if (error instanceof Error && missing(error)) return pageNotFound(session.context);
        if (error instanceof AppError && (error.code === "CLIP_RANGE_INVALID" || error.code === "VIEW_INVALID_VALUE")) {
          return errorResponse(
            session.context,
            400,
            "That selection can't be clipped",
            error.code === "VIEW_INVALID_VALUE"
              ? error.message
              : "A clipping has to be a passage of the article itself. Select a passage of the article, and clip it again.",
            error.code,
          );
        }
        throw error;
      }
    })
    .get("/clippings/:id", async ({ request, params }) => {
      const session = await signedIn(request);
      if (session === null) return toLogin();
      const id = readAnnotationId(params.id);
      if (id === null) return badClippingLink(session.context);
      try {
        return page(<ClippingPage clipping={getClipping(libraryDeps(deps), session.userId, id)} context={session.context} />);
      } catch (error) {
        if (error instanceof Error && missing(error)) return clippingNotFound(session.context);
        throw error;
      }
    })
    .post("/clippings/:id", async ({ request, params }) => {
      const session = await signedIn(request);
      if (session === null) return toLogin();
      const id = readAnnotationId(params.id);
      if (id === null) return badClippingLink(session.context);
      const fields = new URLSearchParams(await request.text());
      try {
        const saved = editNote(libraryDeps(deps), session.userId, id, parseNote(fields.get("note")), deps.now());
        return seeOther(`/clippings?item=${saved.item_id}`);
      } catch (error) {
        if (error instanceof Error && missing(error)) return clippingNotFound(session.context);
        if (error instanceof AppError && error.code === "VIEW_INVALID_VALUE") {
          return errorResponse(session.context, 400, "That note could not be saved", error.message, error.code);
        }
        throw error;
      }
    })
    .get("/clippings/:id/delete", async ({ request, params }) => {
      const session = await signedIn(request);
      if (session === null) return toLogin();
      const id = readAnnotationId(params.id);
      if (id === null) return badClippingLink(session.context);
      try {
        return page(<RemoveClippingPage clipping={getClipping(libraryDeps(deps), session.userId, id)} context={session.context} />);
      } catch (error) {
        if (error instanceof Error && missing(error)) return clippingNotFound(session.context);
        throw error;
      }
    })
    .post("/clippings/:id/delete", async ({ request, params }) => {
      const session = await signedIn(request);
      if (session === null) return toLogin();
      const id = readAnnotationId(params.id);
      if (id === null) return badClippingLink(session.context);
      try {
        const { annotation } = getClipping(libraryDeps(deps), session.userId, id);
        removeClipping(libraryDeps(deps), session.userId, id);
        return seeOther(`/items/${annotation.item_id}`);
      } catch (error) {
        if (error instanceof Error && missing(error)) return clippingNotFound(session.context);
        throw error;
      }
    });
}
