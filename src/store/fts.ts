import { Database, SQLiteError } from "bun:sqlite";

import { AppError } from "../contracts/errors";

export type FtsRow = {
  item_id: string;
  user_id: string;
  title: string;
  author: string | null;
  transcript: string;
};

export type FtsHit = {
  item_id: string;
  title: string;
  snippet: string;
  rank: number;
};

// A UNIQUE violation of any kind, including a duplicate primary key, is a
// conflict. Every other constraint failure keeps its own code. Any other
// driver failure, such as a missing table, is a failed write. Nothing raw
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
    return new AppError("STORE_WRITE_FAILED", error.message, context);
  }
  return error;
}

export function indexItem(db: Database, row: FtsRow): void {
  // Standalone FTS5 has no unique constraint on item_id, so INSERT OR
  // REPLACE would append a second row. Delete first, in one transaction.
  try {
    db.transaction(() => {
      db.run("DELETE FROM items_fts WHERE item_id = ?", [row.item_id]);
      db.run(
        `INSERT INTO items_fts (title, author, transcript, item_id, user_id)
         VALUES (?, ?, ?, ?, ?)`,
        [row.title, row.author, row.transcript, row.item_id, row.user_id],
      );
    })();
  } catch (error) {
    throw translate(error, { item_id: row.item_id, user_id: row.user_id });
  }
}

export function removeItem(db: Database, userId: string, itemId: string): void {
  try {
    db.run("DELETE FROM items_fts WHERE item_id = ? AND user_id = ?", [
      itemId,
      userId,
    ]);
  } catch (error) {
    throw translate(error, { item_id: itemId, user_id: userId });
  }
}

export function searchItems(
  db: Database,
  userId: string,
  query: string,
  limit: number,
): FtsHit[] {
  // The snippet is transcript text byte for byte. The two control characters
  // mark the hit; src/web/ escapes the text and swaps them for markup.
  try {
    return db
      .query<FtsHit, [string, string, number]>(
        `SELECT item_id, title,
              snippet(items_fts, 2, '\u0002', '\u0003', '…', 64) AS snippet,
              rank
       FROM items_fts
       WHERE items_fts MATCH ? AND user_id = ?
       ORDER BY rank LIMIT ?`,
      )
      .all(query, userId, limit);
  } catch (error) {
    throw translate(error, { user_id: userId, query });
  }
}
