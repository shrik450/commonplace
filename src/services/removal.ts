import { AppError, toLogLine } from "../contracts/errors";
import type { ItemId, RequestId, UserId } from "../contracts/ids";
import type { FetchRequest } from "../contracts/item";
import { removeItemDir } from "../store/files";
import { removeBlocks } from "../store/fts";
import { deleteItem, getItem } from "../store/items";
import { deletePageSaveRequests, deleteSaveRequest, getFetchRequest } from "../store/queue";
import type { LibraryDeps } from "./library";

// Removes a page and everything that belongs to it: its clippings and page
// notes, which cascade with the row, its search blocks, its saves, and its
// files. Deleting its unfinished saves cancels them, because a worker can
// only commit a save whose row still exists.
export async function removePage(deps: LibraryDeps, userId: UserId, itemId: ItemId): Promise<void> {
  const remove = deps.db.transaction(() => {
    const item = getItem(deps.db, userId, itemId);
    if (item === null) {
      throw new AppError("STORE_NOT_FOUND", "the item doesn't exist for this user", { user_id: userId, item_id: itemId });
    }
    deletePageSaveRequests(deps.db, userId, itemId, item.url);
    removeBlocks(deps.db, userId, itemId);
    deleteItem(deps.db, userId, itemId);
  });
  remove.immediate();
  try {
    await removeItemDir(deps.itemsRoot, userId, itemId);
  } catch (error) {
    // The page is gone from the library. The orphan sweep removes whatever
    // files are left.
    const reason = error instanceof Error ? error.message : String(error);
    console.error(toLogLine("warn", new AppError("STORE_WRITE_FAILED", "cannot remove a removed page's files", { user_id: userId, item_id: itemId, reason })));
  }
}

// Whether a save can be removed. A finished save is a page, removed as one. A
// save refreshing a page already in the library writes into that page's files
// before it commits, so stopping it partway would leave the page's files out
// of step with its row and its search text.
export type SaveRemoval =
  | { kind: "removable" }
  | { kind: "saved"; itemId: ItemId }
  | { kind: "refreshing"; itemId: ItemId };

export function saveRemoval(deps: LibraryDeps, save: FetchRequest): SaveRemoval {
  if (save.state === "done" && save.item_id !== null) return { kind: "saved", itemId: save.item_id };
  if (save.state === "claimed" && save.item_id !== null && getItem(deps.db, save.user_id, save.item_id) !== null) {
    return { kind: "refreshing", itemId: save.item_id };
  }
  return { kind: "removable" };
}

// Removes a save when it can be removed, and says why not otherwise. Returns
// `null` when the user has no such save. The check and the removal share one
// write transaction, so a worker can't finish the save in between.
export function removeSave(deps: LibraryDeps, userId: UserId, id: RequestId): SaveRemoval | null {
  const remove = deps.db.transaction(() => {
    const save = getFetchRequest(deps.db, userId, id);
    if (save === null) return null;
    const removal = saveRemoval(deps, save);
    if (removal.kind === "removable") deleteSaveRequest(deps.db, userId, id);
    return removal;
  });
  return remove.immediate();
}
