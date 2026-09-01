import { Database, SQLiteError } from "bun:sqlite";

import { AppError } from "../contracts/errors";
import type { Item } from "../contracts/item";

export type Cursor = { created_at: string; id: string };

const ITEM_COLUMNS = `
  id, user_id, kind, url, title, author, created_at, ingested_at
`;

// A UNIQUE violation of any kind, including a duplicate primary key, is a
// conflict. Every other constraint failure keeps its own code. Nothing raw
// leaves L2.
function translate(error: unknown, context: Record<string, unknown>): unknown {
  if (error instanceof SQLiteError) {
    const code = error.code ?? "";
    if (code.includes("CONSTRAINT_UNIQUE") || code.includes("CONSTRAINT_PRIMARYKEY")) {
      return new AppError("STORE_CONFLICT", error.message, context);
    }
    if (code.includes("CONSTRAINT")) {
      return new AppError("STORE_CONSTRAINT_FAILED", error.message, context);
    }
    if (code === "SQLITE_BUSY") {
      return new AppError("STORE_BUSY", error.message, context);
    }
  }
  return error;
}

function requireRow(
  changes: number,
  userId: string,
  id: string,
): void {
  if (changes === 0) {
    throw new AppError("STORE_NOT_FOUND", "no matching item row", {
      user_id: userId,
      id,
    });
  }
}

export function insertItem(db: Database, item: Item): Item {
  try {
    db.run(
      `INSERT INTO items (id, user_id, kind, url, title, author, created_at, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        item.id,
        item.user_id,
        item.kind,
        item.url,
        item.title,
        item.author,
        item.created_at,
        item.ingested_at,
      ],
    );
  } catch (error) {
    throw translate(error, { user_id: item.user_id, id: item.id });
  }
  return item;
}

export function getItem(db: Database, userId: string, id: string): Item | null {
  return (
    db
      .query<Item, [string, string]>(
        `SELECT ${ITEM_COLUMNS} FROM items WHERE user_id = ? AND id = ?`,
      )
      .get(userId, id) ?? null
  );
}

export function getItemByUrl(
  db: Database,
  userId: string,
  url: string,
): Item | null {
  return (
    db
      .query<Item, [string, string]>(
        `SELECT ${ITEM_COLUMNS} FROM items WHERE user_id = ? AND url = ?`,
      )
      .get(userId, url) ?? null
  );
}

export function listItems(
  db: Database,
  userId: string,
  limit: number,
  before?: Cursor,
): Item[] {
  if (before === undefined) {
    return db
      .query<Item, [string, number]>(
        `SELECT ${ITEM_COLUMNS} FROM items WHERE user_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(userId, limit);
  }
  // The cursor is the whole sort key. A created_at alone repeats a row or
  // drops one when two items share a timestamp.
  return db
    .query<Item, [string, string, string, number]>(
      `SELECT ${ITEM_COLUMNS} FROM items
       WHERE user_id = ? AND (created_at, id) < (?, ?)
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(userId, before.created_at, before.id, limit);
}

export function updateItem(
  db: Database,
  userId: string,
  id: string,
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
    let changes: number;
    try {
      const result = db.run(
        `UPDATE items SET ${sets.join(", ")} WHERE user_id = ? AND id = ?`,
        [...values, userId, id],
      );
      changes = result.changes;
    } catch (error) {
      throw translate(error, { user_id: userId, id });
    }
    requireRow(changes, userId, id);
  }
  const row = getItem(db, userId, id);
  if (row === null) {
    requireRow(0, userId, id);
  }
  return row!;
}

export function markIngested(
  db: Database,
  userId: string,
  id: string,
  now: Date,
): Item {
  let changes: number;
  try {
    const result = db.run(
      "UPDATE items SET ingested_at = ? WHERE user_id = ? AND id = ?",
      [now.toISOString(), userId, id],
    );
    changes = result.changes;
  } catch (error) {
    throw translate(error, { user_id: userId, id });
  }
  requireRow(changes, userId, id);
  return getItem(db, userId, id)!;
}

export function deleteItem(db: Database, userId: string, id: string): void {
  db.run("DELETE FROM items WHERE user_id = ? AND id = ?", [userId, id]);
}
