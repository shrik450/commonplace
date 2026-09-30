import { AppError } from "../contracts/errors";
import { newPageNoteId, type ItemId, type PageNoteId, type UserId } from "../contracts/ids";
import type { Item, PageNote } from "../contracts/item";
import { getItem } from "../store/items";
import { deletePageNote, getPageNote, insertPageNote, updatePageNote } from "../store/page-notes";
import type { LibraryDeps } from "./library";

export function addPageNote(
  deps: LibraryDeps,
  userId: UserId,
  itemId: ItemId,
  body: string,
  now: Date,
): PageNote {
  if (getItem(deps.db, userId, itemId) === null) {
    throw new AppError("STORE_NOT_FOUND", "the item doesn't exist for this user", { user_id: userId, item_id: itemId });
  }
  const at = now.toISOString();
  return insertPageNote(deps.db, {
    id: newPageNoteId(),
    user_id: userId,
    item_id: itemId,
    body,
    created_at: at,
    updated_at: at,
  });
}

export type NotedPage = { note: PageNote; item: Item };

export function getNotedPage(deps: LibraryDeps, userId: UserId, id: PageNoteId): NotedPage {
  const note = getPageNote(deps.db, userId, id);
  const item = note === null ? null : getItem(deps.db, userId, note.item_id);
  if (note === null || item === null) {
    throw new AppError("STORE_NOT_FOUND", "the page note doesn't exist for this user", { user_id: userId, id });
  }
  return { note, item };
}

export function editPageNote(
  deps: LibraryDeps,
  userId: UserId,
  id: PageNoteId,
  body: string,
  now: Date,
): PageNote {
  return updatePageNote(deps.db, userId, id, body, now);
}

export function removePageNote(deps: LibraryDeps, userId: UserId, id: PageNoteId): void {
  deletePageNote(deps.db, userId, id);
}
