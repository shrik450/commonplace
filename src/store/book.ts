import { Database } from "bun:sqlite";

import type { ItemId, UserId } from "../contracts/ids";
import type { Item } from "../contracts/item";
import { itemOf, type ItemRow } from "./items";

// The commonplace book holds two kinds of entry: clippings, which are
// annotations, and page notes. These queries read across both.

// `notesOnly` keeps clippings with a note and every page note, since a page
// note is nothing but a note.
export type BookScope = { notesOnly: boolean; itemId: ItemId | null };

export type BookItem = { item: Item; count: number };

export type BookTotals = { clippings: number; pageNotes: number; pages: number; since: string | null };

// A clause to append to a WHERE clause, and its values.
type ScopeSql = { sql: string; params: string[] };

function itemSql(scope: BookScope, column: string): ScopeSql {
  return scope.itemId === null
    ? { sql: "", params: [] }
    : { sql: ` AND ${column} = ?`, params: [scope.itemId] };
}

// Lists every item with at least one entry in scope, newest first, with how
// many entries it has.
export function listBookItems(db: Database, userId: UserId, scope: BookScope): BookItem[] {
  const clippings = itemSql(scope, "a.item_id");
  const notes = itemSql(scope, "p.item_id");
  const noted = scope.notesOnly ? " AND a.note IS NOT NULL AND a.note <> ''" : "";
  return db
    .query<ItemRow & { count: number }, string[]>(
      `SELECT i.id, i.user_id, i.url, i.title, i.author, i.created_at, i.ingested_at,
              i.excerpt, i.content_length, count(*) AS count
       FROM (
         SELECT a.item_id FROM annotations a WHERE a.user_id = ?${noted}${clippings.sql}
         UNION ALL
         SELECT p.item_id FROM page_notes p WHERE p.user_id = ?${notes.sql}
       ) entry
       JOIN items i ON i.id = entry.item_id
       WHERE i.user_id = ?
       GROUP BY i.id
       ORDER BY i.created_at DESC, i.id DESC`,
    )
    .all(userId, ...clippings.params, userId, ...notes.params, userId)
    .map(({ count, ...row }) => ({ item: itemOf(row), count }));
}

export function bookTotals(db: Database, userId: UserId): BookTotals {
  const row = db
    .query<{ clippings: number; page_notes: number; pages: number; since: string | null }, string[]>(
      `SELECT
         (SELECT count(*) FROM annotations WHERE user_id = ?) AS clippings,
         (SELECT count(*) FROM page_notes WHERE user_id = ?) AS page_notes,
         (SELECT count(*) FROM (
           SELECT item_id FROM annotations WHERE user_id = ?
           UNION SELECT item_id FROM page_notes WHERE user_id = ?
         )) AS pages,
         (SELECT min(created_at) FROM (
           SELECT created_at FROM annotations WHERE user_id = ?
           UNION ALL SELECT created_at FROM page_notes WHERE user_id = ?
         )) AS since`,
    )
    .get(userId, userId, userId, userId, userId, userId)!;
  return { clippings: row.clippings, pageNotes: row.page_notes, pages: row.pages, since: row.since };
}
