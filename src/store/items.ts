import { Database } from "bun:sqlite";

import { AppError } from "../contracts/errors";
import type { Item } from "../contracts/item";
import type { ItemId, UserId } from "../contracts/ids";
import { write } from "./db";

export type Cursor = { created_at: string; id: ItemId };

const ITEM_COLUMNS = `
  id, user_id, url, title, author, created_at, ingested_at
`;

type ItemRow = {
  id: ItemId;
  user_id: UserId;
  url: string;
  title: string;
  author: string | null;
  created_at: string;
  ingested_at: string | null;
};

function itemOf(row: ItemRow): Item {
  return row;
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
    `INSERT INTO items (id, user_id, url, title, author, created_at, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      item.id,
      item.user_id,
      item.url,
      item.title,
      item.author,
      item.created_at,
      item.ingested_at,
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

// This unscoped query is used only by the orphan sweep.
export function itemPaths(db: Database): string[] {
  return db
    .query<{ user_id: UserId; id: ItemId }, []>(
      "SELECT user_id, id FROM items",
    )
    .all()
    .map((row) => `${row.user_id}/${row.id}`);
}

export function updateItem(
  db: Database,
  userId: UserId,
  id: ItemId,
  fields: { title?: string; author?: string | null },
): Item {
  const sets: string[] = [];
  const values: (string | null)[] = [];
  if (Object.hasOwn(fields, "title")) {
    sets.push("title = ?");
    values.push(fields.title!);
  }
  if (Object.hasOwn(fields, "author")) {
    sets.push("author = ?");
    values.push(fields.author!);
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
