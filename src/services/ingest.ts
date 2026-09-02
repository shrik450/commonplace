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

// Don't retry errors that another attempt can't resolve. Other failures, such
// as a timeout or temporary I/O error, return to the queue.
const PERMANENT_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "INGEST_UNSUPPORTED_SOURCE",
  "INGEST_LEASE_LOST",
  "INGEST_BLOCK_MISMATCH",
]);

// Converts expected `AppError` failures into queue outcomes. Unexpected errors
// propagate to the worker host.
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

  // Reuse the reserved item ID across retries. For a new request, reuse an item
  // with the same URL to satisfy the `items_user_url` unique index.
  const foundByUrl =
    request.item_id === null
      ? getItemByUrl(deps.db, request.user_id, url)
      : null;
  const itemId = request.item_id ?? foundByUrl?.id ?? newItemId();

  // Reserve the item ID before writing files so the orphan sweep preserves the
  // directory while the request remains active.
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

  // Read metadata from the original HTML because sanitization removes `meta`
  // elements.
  const meta = metadata(original);
  const title = meta.title ?? url;

  const { text, map } = walk(sanitized);
  validateMap(map, text.length);
  if (text.length === 0) {
    throw new AppError(
      "INGEST_EMPTY_TRANSCRIPT",
      "the captured page contains no readable text",
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

  // Store the item, search index, and completed request in one transaction.
  // `bun:sqlite` transactions are synchronous, so all asynchronous work must
  // finish before this point.
  const finishedAt = deps.now();
  const commit = deps.db.transaction(() => {
    // Read the row again because a retry can carry an item ID without running
    // the URL lookup in this attempt.
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
        "another worker claimed the request before the transaction committed",
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
        "runs in the same block have different is_content values",
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
