import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { asItemId, asRequestId, asUserId } from "../../src/contracts/ids";
import type { FetchRequest, Item, User } from "../../src/contracts/item";
import { migrate } from "../../src/store/db";
import { indexBlocks, searchBlocks } from "../../src/store/fts";
import type { BlockRow } from "../../src/store/fts";
import {
  itemDir,
  readItemFile,
  sweepOrphans,
  writeItemFile,
} from "../../src/store/files";
import { insertItem } from "../../src/store/items";
import {
  MAX_ATTEMPTS,
  claimNext,
  completeFetch,
  enqueueFetch,
  pendingItemPaths,
  releaseFetch,
  sweepStaleLeases,
} from "../../src/store/queue";
import { insertUser } from "../../src/store/users";

const ALICE = asUserId("11111111-1111-4111-8111-111111111111");
const BOB = asUserId("22222222-2222-4222-8222-222222222222");
const ITEM_A = asItemId("aaaaaaaa-0000-4000-8000-000000000001");
const ITEM_B = asItemId("aaaaaaaa-0000-4000-8000-000000000002");
const NOW = new Date("2026-02-01T00:00:00.000Z");
const roots: string[] = [];

function requestId(value: string): ReturnType<typeof asRequestId> {
  return asRequestId(`cccccccc-0000-4000-8000-${value.padStart(12, "0")}`);
}

function user(id: ReturnType<typeof asUserId>, subject: string): User {
  return { id, subject, email: null, created_at: NOW.toISOString() };
}

function item(id: ReturnType<typeof asItemId>, userId: ReturnType<typeof asUserId>): Item {
  return {
    id,
    user_id: userId,
    url: `https://example.com/${id}`,
    title: "Saved item",
    author: null,
    created_at: NOW.toISOString(),
    ingested_at: null,
  };
}

function request(
  id: ReturnType<typeof asRequestId>,
  userId: ReturnType<typeof asUserId>,
): FetchRequest {
  return {
    id,
    user_id: userId,
    item_id: null,
    url: "https://example.com/article",
    state: "queued",
    lease_expires_at: null,
    attempts: 0,
    error_code: null,
    created_at: NOW.toISOString(),
  };
}

function db(): Database {
  const value = new Database(":memory:");
  value.exec("PRAGMA foreign_keys = ON");
  migrate(value, NOW);
  insertUser(value, user(ALICE, "alice"));
  insertUser(value, user(BOB, "bob"));
  return value;
}

function fetchRequest(db: Database, userId: ReturnType<typeof asUserId>, id: ReturnType<typeof asRequestId>): FetchRequest | null {
  return db.query<FetchRequest, [string, string]>(
    "SELECT id, user_id, item_id, url, state, lease_expires_at, attempts, error_code, created_at FROM fetch_requests WHERE user_id = ? AND id = ?",
  ).get(userId, id) ?? null;
}

function blocks(itemId: ReturnType<typeof asItemId>, userId: ReturnType<typeof asUserId>): BlockRow[] {
  return [{
    item_id: itemId,
    user_id: userId,
    block_index: 0,
    start_offset: 0,
    end_offset: 12,
    is_content: true,
    text: "private words",
  }];
}

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

describe("queue lifecycle", () => {
  test("claims queued work once and completes it", () => {
    const database = db();
    insertItem(database, item(ITEM_A, ALICE));
    const queued = enqueueFetch(database, request(requestId("1"), ALICE));
    const claimed = claimNext(database, NOW, 60_000)!;

    expect(claimed.id).toBe(queued.id);
    expect(claimed.state).toBe("claimed");
    expect(completeFetch(database, claimed.id, claimed.attempts, ITEM_A)).toBe(true);
    expect(fetchRequest(database, ALICE, claimed.id)).toMatchObject({
      state: "done",
      item_id: ITEM_A,
      lease_expires_at: null,
    });
    expect(claimNext(database, NOW, 60_000)).toBeNull();
    database.close();
  });

  test("releases retryable work back to the queue", () => {
    const database = db();
    const retry = enqueueFetch(database, request(requestId("1"), ALICE));
    const claimed = claimNext(database, NOW, 60_000)!;
    expect(releaseFetch(database, claimed.id, claimed.attempts, "ACQUIRE_TIMEOUT")).toBe(true);
    expect(fetchRequest(database, ALICE, retry.id)!.state).toBe("queued");
    database.close();
  });

  test("an expired lease is requeued, then exhausted after the last attempt", () => {
    const database = db();
    const queued = enqueueFetch(database, request(requestId("1"), ALICE));
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const claimed = claimNext(database, new Date(NOW.getTime() + attempt * 60_000), 1)!;
      expect(claimed!.attempts).toBe(attempt);
      const result = sweepStaleLeases(database, new Date(NOW.getTime() + attempt * 60_000 + 1));
      if (attempt < MAX_ATTEMPTS) expect(result.requeued).toContain(queued.id);
      else expect(result.failed).toContain(queued.id);
    }
    expect(fetchRequest(database, ALICE, queued.id)!.error_code).toBe(
      "INGEST_ATTEMPTS_EXHAUSTED",
    );
    database.close();
  });

  test("a worker with an expired lease cannot finish newer work", () => {
    const database = db();
    insertItem(database, item(ITEM_A, ALICE));
    insertItem(database, item(ITEM_B, ALICE));
    const queued = enqueueFetch(database, request(requestId("1"), ALICE));
    const first = claimNext(database, NOW, 1)!;
    sweepStaleLeases(database, new Date(NOW.getTime() + 2));
    const second = claimNext(database, new Date(NOW.getTime() + 3), 60_000)!;

    expect(completeFetch(database, first.id, first.attempts, ITEM_A)).toBe(false);
    expect(completeFetch(database, second.id, second.attempts, ITEM_B)).toBe(true);
    expect(fetchRequest(database, ALICE, queued.id)!.item_id).toBe(ITEM_B);
    database.close();
  });
});

describe("search behavior", () => {
  test("matches phrases, marks content, limits ranked results, and removes stale blocks", () => {
    const database = db();
    insertItem(database, item(ITEM_A, ALICE));
    indexBlocks(database, ITEM_A, [
      { ...blocks(ITEM_A, ALICE)[0]!, block_index: 0, text: "first inline phrase" },
      { ...blocks(ITEM_A, ALICE)[0]!, block_index: 1, is_content: false, text: "second phrase <b>needle</b>" },
      { ...blocks(ITEM_A, ALICE)[0]!, block_index: 2, text: "third needle" },
    ]);

    const phrase = searchBlocks(database, ALICE, '"inline phrase"', 10);
    expect(phrase).toHaveLength(1);
    expect(phrase[0]!.snippet).toContain("\u0002inline phrase\u0003");
    expect(phrase[0]!.is_content).toBe(true);
    const limited = searchBlocks(database, ALICE, "needle", 1);
    expect(limited).toHaveLength(1);
    const ranked = searchBlocks(database, ALICE, "needle", 10);
    expect(ranked.map((hit) => hit.rank)).toEqual([...ranked.map((hit) => hit.rank)].toSorted((a, b) => a - b));
    expect(ranked.some((hit) => !hit.is_content)).toBe(true);

    indexBlocks(database, ITEM_A, [{ ...blocks(ITEM_A, ALICE)[0]!, text: "replacement" }]);
    expect(searchBlocks(database, ALICE, "needle", 10)).toEqual([]);
    expect(searchBlocks(database, ALICE, "replacement", 10)).toHaveLength(1);
    indexBlocks(database, ITEM_A, []);
    expect(searchBlocks(database, ALICE, "replacement", 10)).toEqual([]);
    database.close();
  });

  test("a search never returns another user's indexed text", () => {
    const database = db();
    insertItem(database, item(ITEM_A, ALICE));
    insertItem(database, item(ITEM_B, BOB));
    indexBlocks(database, ITEM_A, blocks(ITEM_A, ALICE));
    indexBlocks(database, ITEM_B, blocks(ITEM_B, BOB));

    expect(searchBlocks(database, ALICE, "private", 10).map((hit) => hit.item_id)).toEqual([ITEM_A]);
    expect(searchBlocks(database, BOB, "private", 10).map((hit) => hit.item_id)).toEqual([ITEM_B]);
    database.close();
  });

  test("rejecting a block for the wrong item preserves both indexes", () => {
    const database = db();
    insertItem(database, item(ITEM_A, ALICE));
    insertItem(database, item(ITEM_B, BOB));
    indexBlocks(database, ITEM_A, blocks(ITEM_A, ALICE));
    indexBlocks(database, ITEM_B, blocks(ITEM_B, BOB));

    let error: unknown;
    try {
      indexBlocks(database, ITEM_A, [{
        ...blocks(ITEM_A, ALICE)[0]!,
        item_id: ITEM_B,
        user_id: BOB,
        text: "cross-tenant text",
      }]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "STORE_CONSTRAINT_FAILED" });
    expect(searchBlocks(database, ALICE, "private", 10)).toHaveLength(1);
    expect(searchBlocks(database, ALICE, "cross", 10)).toEqual([]);
    expect(searchBlocks(database, BOB, "private", 10)).toHaveLength(1);
    database.close();
  });
});

describe("durable item files", () => {
  test("writes, replaces, reads durable content, and rejects traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "commonplace-files-"));
    roots.push(root);
    await writeItemFile(root, ALICE, ITEM_A, "original.html", "first");
    await writeItemFile(root, ALICE, ITEM_A, "transcript.txt", "second");
    expect(await readItemFile(root, ALICE, ITEM_A, "transcript.txt")).toBe("second");
    expect((await readdir(join(root, ALICE, ITEM_A)).then((entries) => entries.toSorted()))).toEqual(["original.html", "transcript.txt"]);
    await expect(writeItemFile(root, ALICE, "../../escape" as never, "map.json", "x")).rejects.toMatchObject({
      code: "STORE_INVALID_PATH",
    });
  });

  test("sweeps only old unknown item directories and keeps pending work", async () => {
    const root = await mkdtemp(join(tmpdir(), "commonplace-orphans-"));
    roots.push(root);
    await writeItemFile(root, ALICE, ITEM_A, "transcript.txt", "keep");
    await writeItemFile(root, BOB, ITEM_B, "transcript.txt", "drop");
    const database = db();
    enqueueFetch(database, { ...request(requestId("2"), ALICE), item_id: ITEM_A });
    expect(pendingItemPaths(database)).toContain(`${ALICE}/${ITEM_A}`);
    const deleted = await sweepOrphans(root, new Set([`${ALICE}/${ITEM_A}`]), new Date("2099-01-01"));
    expect(deleted).toEqual([itemDir(root, BOB, ITEM_B)]);
    expect(await readdir(join(root, ALICE))).toEqual([ITEM_A]);
    await rm(join(root, ALICE, ITEM_A), { recursive: true, force: true });
    database.close();
  });
});
