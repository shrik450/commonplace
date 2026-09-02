import { Database } from "bun:sqlite";

import { AppError } from "../contracts/errors";
import type { ItemId, UserId } from "../contracts/ids";
import type { Annotation, Item } from "../contracts/item";
import { validateMap } from "../contracts/transcript";
import type { TranscriptMap } from "../contracts/transcript";
import { reanchor } from "../core/anchor";
import { project } from "../core/project";
import type { Highlight } from "../core/project";
import { listAnnotations } from "../store/annotations";
import { readItemFile } from "../store/files";
import { searchBlocks } from "../store/fts";
import { getItem, listItems } from "../store/items";
import type { Cursor } from "../store/items";

export type LibraryDeps = { db: Database; itemsRoot: string };

export type LoadedItem = {
  item: Item;
  transcript: string;
  map: TranscriptMap;
  sanitized: string;
};

export type ReaderPage = LoadedItem & {
  annotations: Annotation[];
  html: string;
};

export type SnippetPart = { text: string; hit: boolean };

export type SearchResult = {
  item: Item;
  block_index: number;
  start_offset: number;
  end_offset: number;
  is_content: boolean;
  snippet: SnippetPart[];
};

// The two control characters searchBlocks wraps a match in. The store keeps
// the snippet byte for byte; splitting it into parts is a view concern, so it
// happens here and never in SQL.
const HIT_OPEN = "\u0002";
const HIT_CLOSE = "\u0003";

export function listLibrary(
  deps: LibraryDeps,
  userId: UserId,
  limit: number,
  before?: Cursor,
): Item[] {
  return listItems(deps.db, userId, limit, before);
}

function requireItem(deps: LibraryDeps, userId: UserId, itemId: ItemId): Item {
  const item = getItem(deps.db, userId, itemId);
  if (item === null) {
    throw new AppError("STORE_NOT_FOUND", "no such item", {
      user_id: userId,
      item_id: itemId,
    });
  }
  return item;
}

export async function loadTranscript(
  deps: LibraryDeps,
  userId: UserId,
  itemId: ItemId,
): Promise<LoadedItem> {
  const item = requireItem(deps, userId, itemId);
  const [sanitized, transcript, raw] = await Promise.all([
    readItemFile(deps.itemsRoot, userId, itemId, "sanitized.html"),
    readItemFile(deps.itemsRoot, userId, itemId, "transcript.txt"),
    readItemFile(deps.itemsRoot, userId, itemId, "map.json"),
  ]);

  const map = JSON.parse(raw) as TranscriptMap;
  validateMap(map, transcript.length);
  return { item, transcript, map, sanitized };
}

export async function captureFile(
  deps: LibraryDeps,
  userId: UserId,
  itemId: ItemId,
): Promise<string> {
  requireItem(deps, userId, itemId);
  return readItemFile(deps.itemsRoot, userId, itemId, "sanitized.html");
}

// Every annotation is placed through its quote before it is drawn. A stored
// offset that still matches its quote is used as it stands; one that drifted
// moves; one whose quote is gone is not drawn at all.
export function placeAnnotations(
  transcript: string,
  annotations: Annotation[],
): Highlight[] {
  const highlights: Highlight[] = [];
  for (const annotation of annotations) {
    const placed = reanchor(transcript, {
      start: annotation.start_offset,
      end: annotation.end_offset,
      quote: annotation.quote,
    });
    if (placed === null) continue;
    highlights.push({
      id: annotation.id,
      start: placed.start,
      end: placed.end,
    });
  }
  return highlights;
}

export async function readerPage(
  deps: LibraryDeps,
  userId: UserId,
  itemId: ItemId,
): Promise<ReaderPage> {
  const loaded = await loadTranscript(deps, userId, itemId);
  const annotations = listAnnotations(deps.db, userId, itemId);
  const html = project({
    sanitizedHtml: loaded.sanitized,
    transcript: loaded.transcript,
    map: loaded.map,
    highlights: placeAnnotations(loaded.transcript, annotations),
  });
  return { ...loaded, annotations, html };
}

export function splitSnippet(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let rest = snippet;
  while (rest.length > 0) {
    const open = rest.indexOf(HIT_OPEN);
    if (open === -1) {
      parts.push({ text: rest, hit: false });
      break;
    }
    if (open > 0) parts.push({ text: rest.slice(0, open), hit: false });
    const close = rest.indexOf(HIT_CLOSE, open);
    if (close === -1) {
      parts.push({ text: rest.slice(open + 1), hit: true });
      break;
    }
    parts.push({ text: rest.slice(open + 1, close), hit: true });
    rest = rest.slice(close + 1);
  }
  return parts.filter((part) => part.text.length > 0);
}

export function searchLibrary(
  deps: LibraryDeps,
  userId: UserId,
  query: string,
  limit: number,
): SearchResult[] {
  if (query.trim() === "") return [];

  const results: SearchResult[] = [];
  const items = new Map<ItemId, Item>();
  for (const hit of searchBlocks(deps.db, userId, query, limit)) {
    let item = items.get(hit.item_id);
    if (item === undefined) {
      const found = getItem(deps.db, userId, hit.item_id);
      if (found === null) continue;
      item = found;
      items.set(hit.item_id, found);
    }
    results.push({
      item,
      block_index: hit.block_index,
      start_offset: hit.start_offset,
      end_offset: hit.end_offset,
      is_content: hit.is_content,
      snippet: splitSnippet(hit.snippet),
    });
  }
  return results;
}
