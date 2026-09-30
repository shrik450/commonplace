import { AppError } from "./errors";
import { asItemId, type ItemId } from "./ids";

// A position in a newest-first list of items. Items sort by creation time,
// then by ID, so two items saved in the same millisecond still have an order.
export type Cursor = { created_at: string; id: ItemId };

// Which page of a newest-first list to show: the newest page, the page just
// older than a cursor, or the page just newer than it.
export type PagePosition =
  | { kind: "newest" }
  | { kind: "before"; cursor: Cursor }
  | { kind: "after"; cursor: Cursor };

const SEPARATOR = "_";
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function cursorOf(row: { created_at: string; id: ItemId }): Cursor {
  return { created_at: row.created_at, id: row.id };
}

export function formatCursor(cursor: Cursor): string {
  return `${cursor.created_at}${SEPARATOR}${cursor.id}`;
}

function invalid(token: string): AppError {
  return new AppError("VIEW_INVALID_CURSOR", "the page link is malformed", { cursor: token });
}

// The only way to turn an untrusted page token into a cursor.
export function parseCursor(token: string): Cursor {
  const at = token.indexOf(SEPARATOR);
  if (at === -1) throw invalid(token);
  const createdAt = token.slice(0, at);
  if (!ISO_TIMESTAMP.test(createdAt) || Number.isNaN(Date.parse(createdAt))) {
    throw invalid(token);
  }
  try {
    return { created_at: createdAt, id: asItemId(token.slice(at + 1)) };
  } catch {
    throw invalid(token);
  }
}

// Reads `before` or `after` from a query string. Both at once is ambiguous,
// so it is as malformed as a bad token.
export function parsePagePosition(params: URLSearchParams): PagePosition {
  const before = params.get("before");
  const after = params.get("after");
  if (before !== null && after !== null) {
    throw new AppError("VIEW_INVALID_CURSOR", "a page link names both directions", { before, after });
  }
  if (before !== null) return { kind: "before", cursor: parseCursor(before) };
  if (after !== null) return { kind: "after", cursor: parseCursor(after) };
  return { kind: "newest" };
}
