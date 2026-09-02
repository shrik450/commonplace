import { Database } from "bun:sqlite";

import { AppError } from "../contracts/errors";
import type { AnnotationId, ItemId, UserId } from "../contracts/ids";
import type { Annotation } from "../contracts/item";
import { write } from "./db";

export type AnnotationFields = {
  note?: string | null;
  start_offset?: number;
  end_offset?: number;
  quote?: string;
};

const ANNOTATION_COLUMNS = `
  id, user_id, item_id, start_offset, end_offset, quote, note, created_at, updated_at
`;

export function insertAnnotation(
  db: Database,
  annotation: Annotation,
): Annotation {
  // Check ownership in the insert statement so another tenant's item can't be
  // referenced between a separate check and write.
  const changes = write(
    db,
    `INSERT INTO annotations
       (id, user_id, item_id, start_offset, end_offset, quote, note, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM items WHERE id = ? AND user_id = ?
     )`,
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
      annotation.item_id,
      annotation.user_id,
    ],
    { user_id: annotation.user_id, id: annotation.id },
  );
  if (changes === 0) {
    throw new AppError("STORE_NOT_FOUND", "the item doesn't exist for this user", {
      user_id: annotation.user_id,
      item_id: annotation.item_id,
    });
  }
  return annotation;
}
export function getAnnotation(
  db: Database,
  userId: UserId,
  id: AnnotationId,
): Annotation | null {
  return (
    db
      .query<Annotation, [string, string]>(
        `SELECT ${ANNOTATION_COLUMNS} FROM annotations
         WHERE user_id = ? AND id = ?`,
      )
      .get(userId, id) ?? null
  );
}

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

export function updateAnnotation(
  db: Database,
  userId: UserId,
  id: AnnotationId,
  fields: AnnotationFields,
  now: Date,
): Annotation {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  if (Object.hasOwn(fields, "note")) {
    sets.push("note = ?");
    values.push(fields.note!);
  }
  if (Object.hasOwn(fields, "start_offset")) {
    sets.push("start_offset = ?");
    values.push(fields.start_offset!);
  }
  if (Object.hasOwn(fields, "end_offset")) {
    sets.push("end_offset = ?");
    values.push(fields.end_offset!);
  }
  if (Object.hasOwn(fields, "quote")) {
    sets.push("quote = ?");
    values.push(fields.quote!);
  }
  sets.push("updated_at = ?");
  values.push(now.toISOString());

  const changes = write(
    db,
    `UPDATE annotations SET ${sets.join(", ")} WHERE user_id = ? AND id = ?`,
    [...values, userId, id],
    { user_id: userId, id },
  );
  if (changes === 0) {
    throw new AppError("STORE_NOT_FOUND", "the annotation doesn't exist for this user", {
      user_id: userId,
      id,
    });
  }
  return getAnnotation(db, userId, id)!;
}

export function deleteAnnotation(
  db: Database,
  userId: UserId,
  id: AnnotationId,
): void {
  write(
    db,
    "DELETE FROM annotations WHERE user_id = ? AND id = ?",
    [userId, id],
    { user_id: userId, id },
  );
}
