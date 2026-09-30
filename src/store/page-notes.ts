import { Database } from "bun:sqlite";

import { AppError } from "../contracts/errors";
import {
  asItemId,
  asPageNoteId,
  asUserId,
  type ItemId,
  type PageNoteId,
  type UserId,
} from "../contracts/ids";
import type { PageNote } from "../contracts/item";
import { write } from "./db";

const PAGE_NOTE_COLUMNS = "id, user_id, item_id, body, created_at, updated_at";

type PageNoteRow = {
  id: string;
  user_id: string;
  item_id: string;
  body: string;
  created_at: string;
  updated_at: string;
};

function pageNoteOf(row: PageNoteRow): PageNote {
  return {
    ...row,
    id: asPageNoteId(row.id),
    user_id: asUserId(row.user_id),
    item_id: asItemId(row.item_id),
  };
}

function notFound(userId: UserId, id: PageNoteId): AppError {
  return new AppError("STORE_NOT_FOUND", "no matching page note row", { user_id: userId, id });
}

export function insertPageNote(db: Database, note: PageNote): PageNote {
  write(
    db,
    `INSERT INTO page_notes (${PAGE_NOTE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`,
    [note.id, note.user_id, note.item_id, note.body, note.created_at, note.updated_at],
    { user_id: note.user_id, id: note.id },
  );
  return note;
}

export function getPageNote(db: Database, userId: UserId, id: PageNoteId): PageNote | null {
  const row = db
    .query<PageNoteRow, [string, string]>(
      `SELECT ${PAGE_NOTE_COLUMNS} FROM page_notes WHERE user_id = ? AND id = ?`,
    )
    .get(userId, id);
  return row === null ? null : pageNoteOf(row);
}

export function updatePageNote(
  db: Database,
  userId: UserId,
  id: PageNoteId,
  body: string,
  updatedAt: Date,
): PageNote {
  const changes = write(
    db,
    "UPDATE page_notes SET body = ?, updated_at = ? WHERE user_id = ? AND id = ?",
    [body, updatedAt.toISOString(), userId, id],
    { user_id: userId, id },
  );
  const row = changes === 0 ? null : getPageNote(db, userId, id);
  if (row === null) throw notFound(userId, id);
  return row;
}

export function deletePageNote(db: Database, userId: UserId, id: PageNoteId): void {
  const changes = write(
    db,
    "DELETE FROM page_notes WHERE user_id = ? AND id = ?",
    [userId, id],
    { user_id: userId, id },
  );
  if (changes === 0) throw notFound(userId, id);
}

// Lists the page notes on the given items, oldest first within each item.
export function listPageNotesForItems(
  db: Database,
  userId: UserId,
  itemIds: readonly ItemId[],
): PageNote[] {
  if (itemIds.length === 0) return [];
  return db
    .query<PageNoteRow, string[]>(
      `SELECT ${PAGE_NOTE_COLUMNS} FROM page_notes
       WHERE user_id = ? AND item_id IN (${itemIds.map(() => "?").join(", ")})
       ORDER BY item_id, created_at ASC, id ASC`,
    )
    .all(userId, ...itemIds)
    .map(pageNoteOf);
}

// Counts each listed item's page notes. Items with none are absent.
export function countPageNotesByItem(
  db: Database,
  userId: UserId,
  itemIds: readonly ItemId[],
): Map<ItemId, number> {
  const counts = new Map<ItemId, number>();
  if (itemIds.length === 0) return counts;
  const rows = db
    .query<{ item_id: string; count: number }, string[]>(
      `SELECT item_id, count(*) AS count FROM page_notes
       WHERE user_id = ? AND item_id IN (${itemIds.map(() => "?").join(", ")})
       GROUP BY item_id`,
    )
    .all(userId, ...itemIds);
  for (const row of rows) counts.set(asItemId(row.item_id), row.count);
  return counts;
}
