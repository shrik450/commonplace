import type { ClipSelection } from "../contracts/clipping";
import { cursorOf, type Cursor, type PagePosition } from "../contracts/cursor";
import { AppError } from "../contracts/errors";
import { newAnnotationId, type AnnotationId, type ItemId, type UserId } from "../contracts/ids";
import type { Annotation, Item, PageNote } from "../contracts/item";
import { runAt } from "../contracts/transcript";
import { clipRange } from "../core/clip";
import { shuffled } from "../core/shuffle";
import {
  deleteAnnotation,
  getAnnotation,
  insertAnnotation,
  listAnnotationsForItems,
  updateAnnotationNote,
} from "../store/annotations";
import { bookTotals, listBookItems, type BookItem, type BookTotals } from "../store/book";
import { getItem } from "../store/items";
import { listPageNotesForItems } from "../store/page-notes";
import { loadTranscript, type LibraryDeps } from "./library";

export type NewClipping = { annotation: Annotation; block_index: number };

// Cuts a clipping from an item's transcript. The quote comes from the stored
// transcript, never from the browser, so a clipping always quotes the page.
export async function addClipping(
  deps: LibraryDeps,
  userId: UserId,
  itemId: ItemId,
  selection: ClipSelection,
  note: string | null,
  now: Date,
): Promise<NewClipping> {
  const { transcript, map } = await loadTranscript(deps, userId, itemId);
  const range = clipRange(transcript, map, selection);
  if (range === null) {
    throw new AppError("CLIP_RANGE_INVALID", "the selection is not a passage of the article", {
      item_id: itemId,
      start: selection.start,
      end: selection.end,
    });
  }
  const at = now.toISOString();
  const annotation = insertAnnotation(deps.db, {
    id: newAnnotationId(),
    user_id: userId,
    item_id: itemId,
    start_offset: range.start,
    end_offset: range.end,
    quote: transcript.slice(range.start, range.end),
    note,
    created_at: at,
    updated_at: at,
  });
  // `clipRange` only accepts a range that starts inside a run.
  return { annotation, block_index: runAt(map, range.start)!.block_index };
}

export type Clipping = { annotation: Annotation; item: Item };

export function getClipping(deps: LibraryDeps, userId: UserId, id: AnnotationId): Clipping {
  const annotation = getAnnotation(deps.db, userId, id);
  const item = annotation === null ? null : getItem(deps.db, userId, annotation.item_id);
  if (annotation === null || item === null) {
    throw new AppError("STORE_NOT_FOUND", "the clipping doesn't exist for this user", { user_id: userId, id });
  }
  return { annotation, item };
}

export function editNote(
  deps: LibraryDeps,
  userId: UserId,
  id: AnnotationId,
  note: string | null,
  now: Date,
): Annotation {
  return updateAnnotationNote(deps.db, userId, id, note, now);
}

export function removeClipping(deps: LibraryDeps, userId: UserId, id: AnnotationId): void {
  deleteAnnotation(deps.db, userId, id);
}

export type BookOrder = { kind: "by-page" } | { kind: "shuffle"; seed: number };

export type BookFilter = {
  notesOnly: boolean;
  itemId: ItemId | null;
  order: BookOrder;
};

// The entries from one page: its clippings in reading order, then its page
// notes, oldest first. A shuffled book puts each entry in a locus of its own.
export type Locus = { item: Item; clippings: Annotation[]; pageNotes: PageNote[] };

// One volume of the commonplace book. A volume holds whole pages' entries,
// newest page first, until it has at least `VOLUME_SIZE` of them. The totals
// describe the whole book, whatever the filter.
export type Book = {
  loci: Locus[];
  clippings: number;
  pageNotes: number;
  totals: BookTotals;
  newer: Cursor | null;
  older: Cursor | null;
};

export const VOLUME_SIZE = 120;

// Compares an item to a cursor in the book's newest-first order: negative
// when the item comes first.
function compareToCursor(entry: BookItem, cursor: Cursor): number {
  if (entry.item.created_at !== cursor.created_at) return entry.item.created_at > cursor.created_at ? -1 : 1;
  if (entry.item.id === cursor.id) return 0;
  return entry.item.id > cursor.id ? -1 : 1;
}

// Whole pages' entries, taken in order until there are at least `size`.
function fill(candidates: readonly BookItem[], size: number): BookItem[] {
  const picked: BookItem[] = [];
  let count = 0;
  for (const candidate of candidates) {
    if (count >= size) break;
    picked.push(candidate);
    count += candidate.count;
  }
  return picked;
}

// The pages in one volume, and where the first sits in the whole book.
export type Volume = { items: BookItem[]; startIndex: number };

// Picks the volume at `position` from every item in the book, newest first.
export function volumeOf(clipped: readonly BookItem[], position: PagePosition, size: number): Volume {
  if (position.kind === "newest") return { items: fill(clipped, size), startIndex: 0 };
  const cursor = position.cursor;
  if (position.kind === "before") {
    const start = clipped.findIndex((entry) => compareToCursor(entry, cursor) > 0);
    if (start === -1) return { items: [], startIndex: clipped.length };
    return { items: fill(clipped.slice(start), size), startIndex: start };
  }
  const end = clipped.findIndex((entry) => compareToCursor(entry, cursor) >= 0);
  const newer = clipped.slice(0, end === -1 ? clipped.length : end);
  const items = fill(newer.toReversed(), size).toReversed();
  return { items, startIndex: newer.length - items.length };
}

function byItem<Entry extends { item_id: ItemId }>(entries: readonly Entry[]): Map<ItemId, Entry[]> {
  const grouped = new Map<ItemId, Entry[]>();
  for (const entry of entries) {
    const list = grouped.get(entry.item_id) ?? [];
    list.push(entry);
    grouped.set(entry.item_id, list);
  }
  return grouped;
}

export function commonplaceBook(
  deps: LibraryDeps,
  userId: UserId,
  filter: BookFilter,
  position: PagePosition,
): Book {
  const clipped = listBookItems(deps.db, userId, { notesOnly: filter.notesOnly, itemId: filter.itemId });
  const { items, startIndex } = volumeOf(clipped, position, VOLUME_SIZE);
  const itemIds = items.map((entry) => entry.item.id);
  const annotations = listAnnotationsForItems(deps.db, userId, itemIds, filter.notesOnly);
  const pageNotes = listPageNotesForItems(deps.db, userId, itemIds);
  const clippingsOf = byItem(annotations);
  const notesOf = byItem(pageNotes);
  const loci = items.map(({ item }) => ({ item, clippings: clippingsOf.get(item.id) ?? [], pageNotes: notesOf.get(item.id) ?? [] }));
  const first = items[0];
  const last = items.at(-1);
  return {
    loci: filter.order.kind === "shuffle"
      ? shuffled(
        loci.flatMap((locus) => [
          ...locus.clippings.map((clipping) => ({ item: locus.item, clippings: [clipping], pageNotes: [] })),
          ...locus.pageNotes.map((note) => ({ item: locus.item, clippings: [], pageNotes: [note] })),
        ]),
        filter.order.seed,
      )
      : loci,
    clippings: annotations.length,
    pageNotes: pageNotes.length,
    totals: bookTotals(deps.db, userId),
    newer: first !== undefined && startIndex > 0 ? cursorOf(first.item) : null,
    older: last !== undefined && startIndex + items.length < clipped.length ? cursorOf(last.item) : null,
  };
}
