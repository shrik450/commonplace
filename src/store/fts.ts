import type { Database } from "bun:sqlite";

import type { ItemId, UserId } from "../contracts/ids";
import { AppError } from "../contracts/errors";
import { translate, write } from "./db";

export type BlockRow = {
  item_id: ItemId;
  user_id: UserId;
  block_index: number;
  start_offset: number;
  end_offset: number;
  is_content: boolean;
  text: string;
};

export type FtsHit = {
  item_id: ItemId;
  block_index: number;
  start_offset: number;
  end_offset: number;
  is_content: boolean;
  snippet: string;
  rank: number;
};

export function indexBlocks(
  db: Database,
  itemId: ItemId,
  blocks: BlockRow[],
): void {
  for (const block of blocks) {
    if (block.item_id !== itemId) {
      // The call deletes every row for `itemId` and inserts this list, so a
      // block that names another item would cross items and, with two users,
      // cross tenants.
      throw new AppError(
        "STORE_CONSTRAINT_FAILED",
        "a block names an item other than the one being indexed",
        { item_id: itemId, block_item_id: block.item_id },
      );
    }
  }
  // FTS5 has no upsert, and INSERT OR REPLACE appends a second row rather
  // than replacing the first, so the old rows go first. The delete and the
  // inserts share one transaction.
  try {
    db.transaction(() => {
      db.run("DELETE FROM blocks_fts WHERE item_id = ?", [itemId]);
      for (const block of blocks) {
        db.run(
          `INSERT INTO blocks_fts
             (text, item_id, user_id, block_index, start_offset, end_offset, is_content)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            block.text,
            block.item_id,
            block.user_id,
            block.block_index,
            block.start_offset,
            block.end_offset,
            block.is_content ? 1 : 0,
          ],
        );
      }
    })();
  } catch (error) {
    throw translate(error, { item_id: itemId, blocks: blocks.length });
  }
}

export function removeItem(db: Database, userId: UserId, itemId: ItemId): void {
  write(
    db,
    "DELETE FROM blocks_fts WHERE item_id = ? AND user_id = ?",
    [itemId, userId],
    { item_id: itemId, user_id: userId },
  );
}

type HitRow = {
  item_id: ItemId;
  block_index: number;
  start_offset: number;
  end_offset: number;
  is_content: number;
  snippet: string;
  rank: number;
};

export function searchBlocks(
  db: Database,
  userId: UserId,
  query: string,
  limit: number,
): FtsHit[] {
  // The snippet is block text byte for byte. The two control characters mark
  // the hit; src/web/ escapes the text and swaps them for markup.
  try {
    return db
      .query<HitRow, [string, string, number]>(
        `SELECT item_id, block_index, start_offset, end_offset, is_content,
              snippet(blocks_fts, 0, '\u0002', '\u0003', '…', 64) AS snippet,
              rank
       FROM blocks_fts
       WHERE blocks_fts MATCH ? AND user_id = ?
       ORDER BY rank LIMIT ?`,
      )
      .all(query, userId, limit)
      .map((row) => ({
        item_id: row.item_id,
        block_index: row.block_index,
        start_offset: row.start_offset,
        end_offset: row.end_offset,
        is_content: row.is_content === 1,
        snippet: row.snippet,
        rank: row.rank,
      }));
  } catch (error) {
    throw translate(error, { user_id: userId, query });
  }
}
