import { Database } from "bun:sqlite";

import { AppError } from "../contracts/errors";
import {
  asAnnotationId,
  asItemId,
  asUserId,
  type AnnotationId,
  type ItemId,
  type UserId,
} from "../contracts/ids";
import type { Annotation } from "../contracts/item";
import { write } from "./db";

const ANNOTATION_COLUMNS = `
  id, user_id, item_id, start_offset, end_offset, quote, note, created_at, updated_at
`;

type AnnotationRow = {
  id: string;
  user_id: string;
  item_id: string;
  start_offset: number;
  end_offset: number;
  quote: string;
  note: string | null;
  created_at: string;
  updated_at: string;
};

function annotationOf(row: AnnotationRow): Annotation {
  return {
    ...row,
    id: asAnnotationId(row.id),
    user_id: asUserId(row.user_id),
    item_id: asItemId(row.item_id),
  };
}

export function insertAnnotation(db: Database, annotation: Annotation): Annotation {
  write(
    db,
    `INSERT INTO annotations (${ANNOTATION_COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      annotation.id,
      annotation.user_id,
      annotation.item_id,
      annotation.start_offset,
      annotation.end_offset,
      annotation.quote,
      annotation.note,
      annotation.created_at,
      annotation.updated_at,
    ],
    { user_id: annotation.user_id, id: annotation.id },
  );
  return annotation;
}

export function getAnnotation(
  db: Database,
  userId: UserId,
  id: AnnotationId,
): Annotation | null {
  const row = db
    .query<AnnotationRow, [string, string]>(
      `SELECT ${ANNOTATION_COLUMNS} FROM annotations WHERE user_id = ? AND id = ?`,
    )
    .get(userId, id);
  return row === null ? null : annotationOf(row);
}

function notFound(userId: UserId, id: AnnotationId): AppError {
  return new AppError("STORE_NOT_FOUND", "no matching annotation row", { user_id: userId, id });
}

export function updateAnnotationNote(
  db: Database,
  userId: UserId,
  id: AnnotationId,
  note: string | null,
  updatedAt: Date,
): Annotation {
  const changes = write(
    db,
    "UPDATE annotations SET note = ?, updated_at = ? WHERE user_id = ? AND id = ?",
    [note, updatedAt.toISOString(), userId, id],
    { user_id: userId, id },
  );
  const row = changes === 0 ? null : getAnnotation(db, userId, id);
  if (row === null) throw notFound(userId, id);
  return row;
}

export function deleteAnnotation(db: Database, userId: UserId, id: AnnotationId): void {
  const changes = write(
    db,
    "DELETE FROM annotations WHERE user_id = ? AND id = ?",
    [userId, id],
    { user_id: userId, id },
  );
  if (changes === 0) throw notFound(userId, id);
}

export function listAnnotations(
  db: Database,
  userId: UserId,
  itemId: ItemId,
): Annotation[] {
  return db
    .query<AnnotationRow, [string, string]>(
      `SELECT ${ANNOTATION_COLUMNS} FROM annotations
       WHERE user_id = ? AND item_id = ?
       ORDER BY start_offset ASC, id ASC`,
    )
    .all(userId, itemId)
    .map(annotationOf);
}

// Counts each listed item's annotations. Items with none are absent.
export function countAnnotationsByItem(
  db: Database,
  userId: UserId,
  itemIds: readonly ItemId[],
): Map<ItemId, number> {
  const counts = new Map<ItemId, number>();
  if (itemIds.length === 0) return counts;
  const rows = db
    .query<{ item_id: string; count: number }, string[]>(
      `SELECT item_id, count(*) AS count FROM annotations
       WHERE user_id = ? AND item_id IN (${itemIds.map(() => "?").join(", ")})
       GROUP BY item_id`,
    )
    .all(userId, ...itemIds);
  for (const row of rows) counts.set(asItemId(row.item_id), row.count);
  return counts;
}

// Lists the annotations on the given items, in reading order within each
// item. `notesOnly` keeps those with a note.
export function listAnnotationsForItems(
  db: Database,
  userId: UserId,
  itemIds: readonly ItemId[],
  notesOnly: boolean,
): Annotation[] {
  if (itemIds.length === 0) return [];
  const noted = notesOnly ? " AND a.note IS NOT NULL AND a.note <> ''" : "";
  return db
    .query<AnnotationRow, string[]>(
      `SELECT a.id, a.user_id, a.item_id, a.start_offset, a.end_offset, a.quote,
              a.note, a.created_at, a.updated_at
       FROM annotations a
       WHERE a.user_id = ? AND a.item_id IN (${itemIds.map(() => "?").join(", ")})${noted}
       ORDER BY a.item_id, a.start_offset ASC, a.id ASC`,
    )
    .all(userId, ...itemIds)
    .map(annotationOf);
}
