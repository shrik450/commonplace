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
import type { Annotation, Item } from "../contracts/item";
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

export type AnnotationFilter = { notesOnly: boolean; itemId: ItemId | null };

export type ClippedItem = { item: Item; count: number };

// A filter as SQL: conditions to append to a WHERE clause, and their values.
type FilterSql = { sql: string; params: string[] };

function filterSql(filter: AnnotationFilter): FilterSql {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filter.notesOnly) clauses.push("a.note IS NOT NULL AND a.note <> ''");
  if (filter.itemId !== null) {
    clauses.push("a.item_id = ?");
    params.push(filter.itemId);
  }
  return { sql: clauses.map((clause) => ` AND ${clause}`).join(""), params };
}

// Lists every item with at least one matching annotation, newest first, with
// how many match.
export function listClippedItems(
  db: Database,
  userId: UserId,
  filter: AnnotationFilter,
): ClippedItem[] {
  const where = filterSql(filter);
  return db
    .query<
      {
        id: string;
        user_id: string;
        url: string;
        title: string;
        author: string | null;
        created_at: string;
        ingested_at: string | null;
        excerpt: string;
        content_length: number;
        count: number;
      },
      string[]
    >(
      `SELECT i.id, i.user_id, i.url, i.title, i.author, i.created_at, i.ingested_at,
              i.excerpt, i.content_length, count(*) AS count
       FROM annotations a JOIN items i ON i.id = a.item_id AND i.user_id = a.user_id
       WHERE a.user_id = ?${where.sql}
       GROUP BY i.id
       ORDER BY i.created_at DESC, i.id DESC`,
    )
    .all(userId, ...where.params)
    .map(({ count, ...row }) => ({
      item: { ...row, id: asItemId(row.id), user_id: asUserId(row.user_id) },
      count,
    }));
}

// Lists the matching annotations on the given items, in reading order within
// each item.
export function listAnnotationsForItems(
  db: Database,
  userId: UserId,
  itemIds: readonly ItemId[],
  filter: AnnotationFilter,
): Annotation[] {
  if (itemIds.length === 0) return [];
  const where = filterSql(filter);
  return db
    .query<AnnotationRow, string[]>(
      `SELECT a.id, a.user_id, a.item_id, a.start_offset, a.end_offset, a.quote,
              a.note, a.created_at, a.updated_at
       FROM annotations a
       WHERE a.user_id = ? AND a.item_id IN (${itemIds.map(() => "?").join(", ")})${where.sql}
       ORDER BY a.item_id, a.start_offset ASC, a.id ASC`,
    )
    .all(userId, ...itemIds, ...where.params)
    .map(annotationOf);
}

export type AnnotationTotals = { clippings: number; pages: number; since: string | null };

export function annotationTotals(db: Database, userId: UserId): AnnotationTotals {
  return db
    .query<AnnotationTotals, [string]>(
      `SELECT count(*) AS clippings, count(DISTINCT item_id) AS pages, min(created_at) AS since
       FROM annotations WHERE user_id = ?`,
    )
    .get(userId)!;
}
