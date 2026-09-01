import { Database, SQLiteError } from "bun:sqlite";

import { AppError } from "../contracts/errors";
import type { Annotation } from "../contracts/item";

export type AnnotationFields = {
  note?: string | null;
  start_offset?: number;
  end_offset?: number;
  quote?: string;
};

const ANNOTATION_COLUMNS = `
  id, user_id, item_id, start_offset, end_offset, quote, note, created_at, updated_at
`;

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

export function insertAnnotation(
  db: Database,
  annotation: Annotation,
): Annotation {
  // One statement carries the ownership check: the insert runs only when the
  // named item exists and belongs to the caller. Zero inserted rows means
  // the item is unknown or another user's.
  let changes: number;
  try {
    const result = db.run(
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
    );
    changes = result.changes;
  } catch (error) {
    throw translate(error, { user_id: annotation.user_id, id: annotation.id });
  }
  if (changes === 0) {
    throw new AppError("STORE_NOT_FOUND", "no owned item with that item_id", {
      user_id: annotation.user_id,
      item_id: annotation.item_id,
    });
  }
  return annotation;
}

export function getAnnotation(
  db: Database,
  userId: string,
  id: string,
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
  userId: string,
  itemId: string,
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
  userId: string,
  id: string,
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

  let changes: number;
  try {
    const result = db.run(
      `UPDATE annotations SET ${sets.join(", ")} WHERE user_id = ? AND id = ?`,
      [...values, userId, id],
    );
    changes = result.changes;
  } catch (error) {
    throw translate(error, { user_id: userId, id });
  }
  if (changes === 0) {
    throw new AppError("STORE_NOT_FOUND", "no matching annotation row", {
      user_id: userId,
      id,
    });
  }
  return getAnnotation(db, userId, id)!;
}

export function deleteAnnotation(
  db: Database,
  userId: string,
  id: string,
): void {
  db.run("DELETE FROM annotations WHERE user_id = ? AND id = ?", [userId, id]);
}
