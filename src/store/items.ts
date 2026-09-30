import { Database } from "bun:sqlite";

import type { Cursor } from "../contracts/cursor";
import { AppError } from "../contracts/errors";
import type { Item, ItemSummary } from "../contracts/item";
import { asItemId, asUserId, type ItemId, type UserId } from "../contracts/ids";
import { write } from "./db";

const ITEM_COLUMNS = `
  id, user_id, url, title, author, created_at, ingested_at, excerpt, content_length
`;

export type ItemRow = {
  id: string;
  user_id: string;
  url: string;
  title: string;
  author: string | null;
  created_at: string;
  ingested_at: string | null;
  excerpt: string;
  content_length: number;
};

export function itemOf(row: ItemRow): Item {
  return { ...row, id: asItemId(row.id), user_id: asUserId(row.user_id) };
}

function requireRow(changes: number, userId: UserId, id: ItemId): void {
  if (changes === 0) {
    throw new AppError("STORE_NOT_FOUND", "no matching item row", {
      user_id: userId,
      id,
    });
  }
}

export function insertItem(db: Database, item: Item): Item {
  write(
    db,
    `INSERT INTO items (id, user_id, url, title, author, created_at, ingested_at, excerpt, content_length)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      item.id,
      item.user_id,
      item.url,
      item.title,
      item.author,
      item.created_at,
      item.ingested_at,
      item.excerpt,
      item.content_length,
    ],
    { user_id: item.user_id, id: item.id },
  );
  return item;
}

export function getItem(db: Database, userId: UserId, id: ItemId): Item | null {
  const row = db
    .query<ItemRow, [string, string]>(
      `SELECT ${ITEM_COLUMNS} FROM items WHERE user_id = ? AND id = ?`,
    )
    .get(userId, id);
  return row === null ? null : itemOf(row);
}

export function getItemByUrl(
  db: Database,
  userId: UserId,
  url: string,
): Item | null {
  const row = db
    .query<ItemRow, [string, string]>(
      `SELECT ${ITEM_COLUMNS} FROM items WHERE user_id = ? AND url = ?`,
    )
    .get(userId, url);
  return row === null ? null : itemOf(row);
}

// Lists items newest first, starting just older than `before` when given.
export function listItems(
  db: Database,
  userId: UserId,
  limit: number,
  before?: Cursor,
): Item[] {
  if (before === undefined) {
    return db
      .query<ItemRow, [string, number]>(
        `SELECT ${ITEM_COLUMNS} FROM items WHERE user_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(userId, limit)
      .map(itemOf);
  }
  return db
    .query<ItemRow, [string, string, string, number]>(
      `SELECT ${ITEM_COLUMNS} FROM items
       WHERE user_id = ? AND (created_at, id) < (?, ?)
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(userId, before.created_at, before.id, limit)
    .map(itemOf);
}

// Lists the `limit` items just newer than `after`, newest first.
export function listItemsAfter(
  db: Database,
  userId: UserId,
  limit: number,
  after: Cursor,
): Item[] {
  return db
    .query<ItemRow, [string, string, string, number]>(
      `SELECT ${ITEM_COLUMNS} FROM items
       WHERE user_id = ? AND (created_at, id) > (?, ?)
       ORDER BY created_at ASC, id ASC LIMIT ?`,
    )
    .all(userId, after.created_at, after.id, limit)
    .map(itemOf)
    .toReversed();
}

export function countItems(db: Database, userId: UserId): number {
  return db
    .query<{ count: number }, [string]>(
      "SELECT count(*) AS count FROM items WHERE user_id = ?",
    )
    .get(userId)!.count;
}

export function countItemsNewerThan(
  db: Database,
  userId: UserId,
  cursor: Cursor,
): number {
  return db
    .query<{ count: number }, [string, string, string]>(
      `SELECT count(*) AS count FROM items
       WHERE user_id = ? AND (created_at, id) > (?, ?)`,
    )
    .get(userId, cursor.created_at, cursor.id)!.count;
}

export function deleteItem(db: Database, userId: UserId, id: ItemId): void {
  const changes = write(
    db,
    "DELETE FROM items WHERE user_id = ? AND id = ?",
    [userId, id],
    { user_id: userId, id },
  );
  requireRow(changes, userId, id);
}

// This unscoped query is used only by the orphan sweep.
export function itemPaths(db: Database): string[] {
  return db
    .query<{ user_id: string; id: string }, []>(
      "SELECT user_id, id FROM items",
    )
    .all()
    .map((row) => `${asUserId(row.user_id)}/${asItemId(row.id)}`);
}

export function updateItem(
  db: Database,
  userId: UserId,
  id: ItemId,
  fields: { title?: string; author?: string | null; summary?: ItemSummary },
): Item {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  if (Object.hasOwn(fields, "title")) {
    sets.push("title = ?");
    values.push(fields.title!);
  }
  if (Object.hasOwn(fields, "author")) {
    sets.push("author = ?");
    values.push(fields.author!);
  }
  if (fields.summary !== undefined) {
    sets.push("excerpt = ?", "content_length = ?");
    values.push(fields.summary.excerpt, fields.summary.content_length);
  }
  if (sets.length > 0) {
    const changes = write(
      db,
      `UPDATE items SET ${sets.join(", ")} WHERE user_id = ? AND id = ?`,
      [...values, userId, id],
      { user_id: userId, id },
    );
    requireRow(changes, userId, id);
  }
  const row = getItem(db, userId, id);
  if (row === null) requireRow(0, userId, id);
  return row!;
}

export function markIngested(
  db: Database,
  userId: UserId,
  id: ItemId,
  now: Date,
): Item {
  const changes = write(
    db,
    "UPDATE items SET ingested_at = ? WHERE user_id = ? AND id = ?",
    [now.toISOString(), userId, id],
    { user_id: userId, id },
  );
  requireRow(changes, userId, id);
  return getItem(db, userId, id)!;
}
