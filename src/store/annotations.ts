import { Database } from "bun:sqlite";

import type { ItemId, UserId } from "../contracts/ids";
import type { Annotation } from "../contracts/item";

const ANNOTATION_COLUMNS = `
  id, user_id, item_id, start_offset, end_offset, quote, note, created_at, updated_at
`;

// Annotation creation is not exposed until the selection-to-save flow exists.
// Keep reading rows so existing annotations continue to render correctly.
export function listAnnotations(
  db: Database,
  userId: UserId,
  itemId: ItemId,
): Annotation[] {
  return db
    .query<Annotation, [string, string]>(
      `SELECT ${ANNOTATION_COLUMNS} FROM annotations
       WHERE user_id = ? AND item_id = ?
       ORDER BY start_offset ASC, id ASC`,
    )
    .all(userId, itemId);
}
