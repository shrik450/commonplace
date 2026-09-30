import { Elysia } from "elysia";

import { parsePageNote } from "../../contracts/clipping";
import { AppError } from "../../contracts/errors";
import { asItemId, asPageNoteId, type ItemId, type PageNoteId } from "../../contracts/ids";
import { authenticate } from "../../services/auth";
import { addPageNote, editPageNote, getNotedPage, removePageNote } from "../../services/page-notes";
import { page, type PageContext } from "../views/layout";
import { PageNotePage, RemovePageNotePage } from "../views/page-notes";
import { authDeps, libraryDeps, pageContext, toLogin, type WebDeps } from "./deps";
import { errorResponse, seeOther } from "./errors";

function readPageNoteId(raw: string): PageNoteId | null {
  try {
    return asPageNoteId(raw);
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

function refused(error: Error): error is AppError {
  return error instanceof AppError && (error.code === "VIEW_INVALID_VALUE" || error.code === "VIEW_MISSING_FIELD");
}

function badNoteLink(context: PageContext): Response {
  return errorResponse(
    context,
    400,
    "That note address is invalid",
    "A valid note address ends with a note ID. Open the page the note is on, and choose the note again.",
  );
}

function noteNotFound(context: PageContext): Response {
  return errorResponse(
    context,
    404,
    "Commonplace cannot find that note",
    "Your library has no note at this address. It may have been removed, along with its page.",
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

function unsaved(context: PageContext, error: AppError): Response {
  return errorResponse(context, 400, "That note could not be saved", error.message, error.code);
}

const readerNotes = (itemId: ItemId) => `/items/${itemId}#page-notes`;

export function pageNoteRoutes(deps: WebDeps) {
  const signedIn = async (request: Request) => {
    const principal = await authenticate(request, authDeps(deps)).catch(() => null);
    if (principal === null) return null;
    return { userId: principal.user.id, context: pageContext(deps, principal.user.id, request) };
  };

  return new Elysia()
    .post("/items/:id/page-notes", async ({ request, params }) => {
      const session = await signedIn(request);
      if (session === null) return toLogin();
      const itemId = readItemId(params.id);
      if (itemId === null) {
        return errorResponse(session.context, 400, "That item address is invalid", "Open your library, and select the page again.");
      }
      const fields = new URLSearchParams(await request.text());
      try {
        addPageNote(libraryDeps(deps), session.userId, itemId, parsePageNote(fields.get("note")), deps.now());
        return seeOther(readerNotes(itemId));
      } catch (error) {
        if (error instanceof Error && missing(error)) return pageNotFound(session.context);
        if (error instanceof Error && refused(error)) return unsaved(session.context, error);
        throw error;
      }
    })
    .get("/page-notes/:id", async ({ request, params }) => {
      const session = await signedIn(request);
      if (session === null) return toLogin();
      const id = readPageNoteId(params.id);
      if (id === null) return badNoteLink(session.context);
      try {
        return page(<PageNotePage noted={getNotedPage(libraryDeps(deps), session.userId, id)} context={session.context} />);
      } catch (error) {
        if (error instanceof Error && missing(error)) return noteNotFound(session.context);
        throw error;
      }
    })
    .post("/page-notes/:id", async ({ request, params }) => {
      const session = await signedIn(request);
      if (session === null) return toLogin();
      const id = readPageNoteId(params.id);
      if (id === null) return badNoteLink(session.context);
      const fields = new URLSearchParams(await request.text());
      try {
        const saved = editPageNote(libraryDeps(deps), session.userId, id, parsePageNote(fields.get("note")), deps.now());
        return seeOther(readerNotes(saved.item_id));
      } catch (error) {
        if (error instanceof Error && missing(error)) return noteNotFound(session.context);
        if (error instanceof Error && refused(error)) return unsaved(session.context, error);
        throw error;
      }
    })
    .get("/page-notes/:id/delete", async ({ request, params }) => {
      const session = await signedIn(request);
      if (session === null) return toLogin();
      const id = readPageNoteId(params.id);
      if (id === null) return badNoteLink(session.context);
      try {
        return page(<RemovePageNotePage noted={getNotedPage(libraryDeps(deps), session.userId, id)} context={session.context} />);
      } catch (error) {
        if (error instanceof Error && missing(error)) return noteNotFound(session.context);
        throw error;
      }
    })
    .post("/page-notes/:id/delete", async ({ request, params }) => {
      const session = await signedIn(request);
      if (session === null) return toLogin();
      const id = readPageNoteId(params.id);
      if (id === null) return badNoteLink(session.context);
      try {
        const { note } = getNotedPage(libraryDeps(deps), session.userId, id);
        removePageNote(libraryDeps(deps), session.userId, id);
        return seeOther(readerNotes(note.item_id));
      } catch (error) {
        if (error instanceof Error && missing(error)) return noteNotFound(session.context);
        throw error;
      }
    });
}
