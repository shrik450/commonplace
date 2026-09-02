import { Database } from "bun:sqlite";
import { join } from "node:path";

import { sanitize } from "../core/sanitize";
import { metadata, walk } from "../core/walk";
import type { ErrorCode } from "../contracts/errors";
import { AppError } from "../contracts/errors";
import type { ItemId } from "../contracts/ids";
import { newItemId } from "../contracts/ids";
import type { FetchRequest } from "../contracts/item";
import { validateMap, type Run } from "../contracts/transcript";
import type { CaptureRequest, CaptureResult } from "./acquire";
import {
  ensureItemDir,
  readItemFile,
  writeItemFile,
} from "../store/files";
import { indexBlocks, type BlockRow } from "../store/fts";
import {
  getItem,
  getItemByUrl,
  insertItem,
  markIngested,
  updateItem,
} from "../store/items";
import { completeFetch, reserveItem } from "../store/queue";

export type IngestDeps = {
  db: Database;
  itemsRoot: string;
  now: () => Date;
  capture: (request: CaptureRequest) => Promise<CaptureResult>;
  browserPath?: string;
  captureTimeoutMs?: number;
};

export type IngestOutcome =
  | { state: "done"; itemId: ItemId }
  | { state: "retry"; code: ErrorCode; message: string }
  | { state: "failed"; code: ErrorCode; message: string };

// A second attempt cannot change these. An EPUB stays an EPUB, a lost lease
// belongs to another worker, and a malformed Map is a walker bug. Everything
// else — a timeout, a dead browser, a full disk — may succeed next time.
const PERMANENT_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "INGEST_UNSUPPORTED_SOURCE",
  "INGEST_LEASE_LOST",
  "INGEST_BLOCK_MISMATCH",
]);

// The one that runs the pipeline. Every AppError becomes an outcome; a
// non-AppError is a bug and escapes.
export async function ingestRequest(
  deps: IngestDeps,
  request: FetchRequest,
): Promise<IngestOutcome> {
  try {
    return await runIngest(deps, request);
  } catch (error) {
    if (error instanceof AppError) {
      if (PERMANENT_CODES.has(error.code)) {
        return { state: "failed", code: error.code, message: error.message };
      }
      return { state: "retry", code: error.code, message: error.message };
    }
    throw error;
  }
}

async function runIngest(
  deps: IngestDeps,
  request: FetchRequest,
): Promise<IngestOutcome> {
  if (request.source_path !== null || request.url === null) {
    throw new AppError(
      "INGEST_UNSUPPORTED_SOURCE",
      "only HTML fetched from a URL can be ingested",
      { request_id: request.id, url: request.url },
    );
  }
  const url = request.url;

  // Choose the item id: the request's own reservation first, then the URL
  // lookup — items carries UNIQUE INDEX items_user_url, so a minted id for a
  // URL the user already holds would throw STORE_CONFLICT — then a new id.
  // The lookup only chooses the id; the commit decides insert against update
  // by reading the row.
  const foundByUrl =
    request.item_id === null
      ? getItemByUrl(deps.db, request.user_id, url)
      : null;
  const itemId = request.item_id ?? foundByUrl?.id ?? newItemId();

  // Reserve before any file is written. The reservation is what tells the
  // orphan sweep the directory is still needed while this request is claimed.
  if (!reserveItem(deps.db, request.id, request.attempts, itemId)) {
    throw new AppError(
      "INGEST_LEASE_LOST",
      "another worker owns this request; nothing was written",
      { request_id: request.id },
    );
  }

  const dir = await ensureItemDir(deps.itemsRoot, request.user_id, itemId);
  await deps.capture({
    url,
    outputPath: join(dir, "original.html"),
    browserPath: deps.browserPath,
    timeoutMs: deps.captureTimeoutMs,
  });

  const original = await readItemFile(
    deps.itemsRoot,
    request.user_id,
    itemId,
    "original.html",
  );
  const sanitized = sanitize(original);
  await writeItemFile(
    deps.itemsRoot,
    request.user_id,
    itemId,
    "sanitized.html",
    sanitized,
  );

  // Metadata reads the original, never the sanitized copy, because the
  // sanitizer deletes every meta element.
  const meta = metadata(original);
  const title = meta.title ?? url;

  const { text, map } = walk(sanitized);
  validateMap(map, text.length);
  if (text.length === 0) {
    throw new AppError(
      "INGEST_EMPTY_TRANSCRIPT",
      "the page walked to no text; the capture reported success but wrote nothing readable",
      { url },
    );
  }

  await writeItemFile(
    deps.itemsRoot,
    request.user_id,
    itemId,
    "transcript.txt",
    text,
  );
  await writeItemFile(
    deps.itemsRoot,
    request.user_id,
    itemId,
    "map.json",
    JSON.stringify(map),
  );

  const blocks = buildBlocks(map.runs, text, itemId, request.user_id);

  // One transaction: item row, block index, completed request. A crash
  // mid-commit leaves none of them, and a lost lease rolls all of it back.
  // bun:sqlite transactions are synchronous, so every await already happened.
  const finishedAt = deps.now();
  const commit = deps.db.transaction(() => {
    // Decide insert against update by reading the row, not by remembering
    // which lookup chose the id. A retry carries its reservation, so the
    // URL lookup never ran on this attempt even when the item already exists.
    const existing = getItem(deps.db, request.user_id, itemId);
    if (existing === null) {
      insertItem(deps.db, {
        id: itemId,
        user_id: request.user_id,
        kind: "article",
        url,
        title,
        author: meta.author,
        created_at: finishedAt.toISOString(),
        ingested_at: null,
      });
    } else {
      updateItem(deps.db, request.user_id, itemId, {
        title,
        author: meta.author,
      });
    }
    markIngested(deps.db, request.user_id, itemId, finishedAt);
    indexBlocks(deps.db, itemId, blocks);
    if (!completeFetch(deps.db, request.id, request.attempts, itemId)) {
      throw new AppError(
        "INGEST_LEASE_LOST",
        "the lease was lost before the commit; the transaction rolled back",
        { request_id: request.id },
      );
    }
  });
  commit();

  return { state: "done", itemId };
}

function buildBlocks(
  runs: Run[],
  transcript: string,
  itemId: ItemId,
  userId: FetchRequest["user_id"],
): BlockRow[] {
  type Group = { start: number; end: number; isContent: boolean };
  const groups = new Map<number, Group>();
  for (const run of runs) {
    const group = groups.get(run.block_index);
    if (group === undefined) {
      groups.set(run.block_index, {
        start: run.start,
        end: run.end,
        isContent: run.is_content,
      });
      continue;
    }
    if (group.isContent !== run.is_content) {
      throw new AppError(
        "INGEST_BLOCK_MISMATCH",
        "runs in one block disagree on is_content",
        { block_index: run.block_index },
      );
    }
    group.end = run.end;
  }

  const blocks: BlockRow[] = [];
  for (const [blockIndex, group] of groups) {
    const blockText = transcript.slice(group.start, group.end);
    if (blockText.trim() === "") continue;
    blocks.push({
      item_id: itemId,
      user_id: userId,
      block_index: blockIndex,
      start_offset: group.start,
      end_offset: group.end,
      is_content: group.isContent,
      text: blockText,
    });
  }
  return blocks;
}
