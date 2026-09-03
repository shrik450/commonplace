// Acceptance test for milestone 2. It is the specification for that work.
// Change it only when the design changes, and say what changed and why.
//
// What the implementer must create
// --------------------------------
// `src/store/queue.ts`, `src/store/fts.ts`, and `src/store/files.ts`, with the
//
// Contract details this file pins down
// ------------------------------------
// The brief leaves these open. This file settles them, so build them this way.
//
// - `claimNext` writes `lease_expires_at` as
//   `new Date(now.getTime() + leaseMs).toISOString()`.
// - `claimNext` uses the one `UPDATE ... RETURNING` statement the brief
//   prints, spelled as the brief prints it. A source check below reads
//   `src/store/queue.ts` and proves there is exactly one such statement and no
//   separate `SELECT id FROM fetch_requests`. Two statements would let two
//   workers claim one job, so the shape of the SQL is part of the contract.
// - `claimNext` returns `null` only for an empty queue. A write conflict
//   throws `STORE_BUSY`, and the test below arranges a real one.
// - `completeFetch` and `failFetch` are fenced on `attempts` and return
//   `changes === 1`. Both clear `lease_expires_at`. Both match only a row in
//   state `claimed`.
// - `searchBlocks` builds its snippet from the `text` column, marking the hit
//   with `\u0002` and `\u0003`. The snippet is plain text; L2 emits no HTML.
// - `indexBlocks` deletes every row for the item then inserts the new set, so
//   indexing twice leaves one row per block.
// - `writeItemFile` writes `.tmp-<pid>-<n>` in the target directory and
//   renames it over the target. The counter makes the name unique per call, so
//   two concurrent writes of one file cannot mix.
// - `sweepOrphans` returns absolute paths, sorted, one per deleted directory.
//
// - Search indexes blocks in `blocks_fts`. A hit carries the block index, the
//   transcript range, and `is_content`, so the reader can jump to the passage
//   and milestone 8 can filter.
// - Every id is branded, so an `ItemId` cannot stand in for a `UserId`.
// - Every write goes through `write` from `src/store/db.ts`, so a readonly
//   database raises `STORE_WRITE_FAILED` rather than a raw `SQLiteError`.
//
// Timestamps
// ----------
// Every timestamp is a literal the test controls. A store that reads the
// clock fails these tests. `sweepOrphans` reads the mtime of a directory the
// test just created, so the tests bracket it with a date far in the past and
// one far in the future rather than a date near now.

import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FetchRequest, Item, User } from "../../src/contracts/item";
import type { ItemId, RequestId, UserId } from "../../src/contracts/ids";
import { asItemId, asRequestId, asUserId } from "../../src/contracts/ids";
import { AppError, isAppError } from "../../src/contracts/errors";
import { migrate, openDatabase } from "../../src/store/db";
import { insertItem } from "../../src/store/items";
import { insertUser } from "../../src/store/users";
import {
  MAX_ATTEMPTS,
  claimNext,
  completeFetch,
  enqueueFetch,
  failFetch,
  sweepStaleLeases,
} from "../../src/store/queue";
import type { BlockRow } from "../../src/store/fts";
import { indexBlocks, searchBlocks } from "../../src/store/fts";
import {
  itemDir,
  readItemFile,
  sweepOrphans,
  writeItemFile,
} from "../../src/store/files";

const repoRoot = join(import.meta.dir, "..", "..");

const T0 = new Date("2026-02-01T00:00:00.000Z");
const LONG_AGO = new Date("2020-01-01T00:00:00.000Z");
const FAR_AHEAD = new Date("2099-01-01T00:00:00.000Z");

const MARK_OPEN = "\u0002";
const MARK_CLOSE = "\u0003";

// Every id goes through its as* constructor. A bare string would not compile,
// which is the point of the brands.
const ALICE = asUserId("11111111-1111-4111-8111-111111111111");
const BOB = asUserId("22222222-2222-4222-8222-222222222222");
const ITEM_A = asItemId("aaaaaaaa-0000-4000-8000-000000000001");
const ITEM_B = asItemId("aaaaaaaa-0000-4000-8000-000000000002");
const ITEM_C = asItemId("aaaaaaaa-0000-4000-8000-000000000003");
const ITEM_D = asItemId("aaaaaaaa-0000-4000-8000-000000000004");

function requestId(n: number): RequestId {
  return asRequestId(`cccccccc-0000-4000-8000-${String(n).padStart(12, "0")}`);
}

const tempRoots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "commonplace-store-files-"));
  tempRoots.push(root);
  return root;
}

afterAll(async () => {
  for (const root of tempRoots) {
    await rm(root, { recursive: true, force: true });
  }
});

function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

async function caughtAsync(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to reject");
}

function appErrorCode(error: unknown): string {
  expect(isAppError(error)).toBe(true);
  return (error as AppError).code;
}

function caughtAppErrorCode(run: () => unknown): string {
  return appErrorCode(caught(run));
}

async function rejectedAppErrorCode(run: () => Promise<unknown>): Promise<string> {
  return appErrorCode(await caughtAsync(run));
}

function makeUser(id: UserId, subject: string): User {
  return { id, subject, email: null, created_at: T0.toISOString() };
}

function makeItem(id: ItemId, userId: UserId, title: string): Item {
  return {
    id,
    user_id: userId,
      url: `https://example.com/${id}`,
    title,
    author: null,
    created_at: T0.toISOString(),
    ingested_at: null,
  };
}

function makeRequest(
  overrides: Partial<FetchRequest> & { id: RequestId; user_id: UserId },
): FetchRequest {
  return {
    item_id: null,
    url: "https://example.com/post",
    state: "queued",
    lease_expires_at: null,
    attempts: 0,
    error_code: null,
    created_at: T0.toISOString(),
    ...overrides,
  };
}

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, T0);
  insertUser(db, makeUser(ALICE, "alice"));
  insertUser(db, makeUser(BOB, "bob"));
  return db;
}

function blockRow(overrides: Partial<BlockRow> = {}): BlockRow {
  return {
    item_id: ITEM_A,
    user_id: ALICE,
    block_index: 0,
    start_offset: 0,
    end_offset: 44,
    is_content: true,
    text: "The quick brown fox jumps over the lazy dog.",
    ...overrides,
  };
}

// Two blocks of one article. Only the second holds the word the searches
// look for, so a hit names a block and not the whole item.
function aliceBlocks(): BlockRow[] {
  return [
    blockRow({ block_index: 0 }),
    blockRow({
      block_index: 1,
      start_offset: 44,
      end_offset: 69,
      text: "A wombat digs a burrow.",
    }),
  ];
}

function bobBlocks(): BlockRow[] {
  return [
    blockRow({
      item_id: ITEM_B,
      user_id: BOB,
      block_index: 0,
      text: "Another wombat digs another burrow.",
    }),
  ];
}

function blockCount(db: Database, itemId: ItemId): number {
  return db
    .query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM blocks_fts WHERE item_id = ?",
    )
    .get(itemId)!.n;
}

function seededFtsDb(): Database {
  const db = freshDb();
  insertItem(db, makeItem(ITEM_A, ALICE, "A field guide"));
  insertItem(db, makeItem(ITEM_B, BOB, "A field guide"));
  return db;
}

function rawRequest(db: Database, id: string): FetchRequest {
  const row = db
    .query<FetchRequest, [string]>("SELECT * FROM fetch_requests WHERE id = ?")
    .get(id);
  expect(row).not.toBeNull();
  return row!;
}

describe("src/store/queue claimNext", () => {
  test("returns null on an empty queue", () => {
    const db = freshDb();
    expect(claimNext(db, T0, 60_000)).toBeNull();
    db.close();
  });

  test("claims the one job, then returns null", () => {
    const db = freshDb();
    enqueueFetch(db, makeRequest({ id: requestId(1), user_id: ALICE }));

    const claimed = claimNext(db, T0, 60_000);
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(requestId(1));
    expect(claimed!.state).toBe("claimed");
    expect(claimed!.attempts).toBe(1);
    expect(claimed!.lease_expires_at).toBe("2026-02-01T00:01:00.000Z");

    expect(claimNext(db, T0, 60_000)).toBeNull();

    const stored = rawRequest(db, requestId(1));
    expect(stored.state).toBe("claimed");
    expect(stored.attempts).toBe(1);
    db.close();
  });

  test("claims in created_at order, then id order", () => {
    const db = freshDb();
    enqueueFetch(
      db,
      makeRequest({
        id: requestId(3),
        user_id: ALICE,
        created_at: "2026-02-03T00:00:00.000Z",
      }),
    );
    enqueueFetch(
      db,
      makeRequest({
        id: requestId(2),
        user_id: ALICE,
        created_at: "2026-02-02T00:00:00.000Z",
      }),
    );
    enqueueFetch(
      db,
      makeRequest({
        id: requestId(1),
        user_id: ALICE,
        created_at: "2026-02-02T00:00:00.000Z",
      }),
    );

    const order = [
      claimNext(db, T0, 60_000)?.id,
      claimNext(db, T0, 60_000)?.id,
      claimNext(db, T0, 60_000)?.id,
    ];
    expect(order).toEqual([requestId(1), requestId(2), requestId(3)]);
    expect(claimNext(db, T0, 60_000)).toBeNull();
    db.close();
  });

  test("claims across users, because the worker serves everyone", () => {
    const db = freshDb();
    enqueueFetch(
      db,
      makeRequest({
        id: requestId(3),
        user_id: BOB,
        created_at: "2026-02-01T00:00:00.000Z",
      }),
    );
    enqueueFetch(
      db,
      makeRequest({
        id: requestId(1),
        user_id: ALICE,
        created_at: "2026-02-02T00:00:00.000Z",
      }),
    );

    expect(claimNext(db, T0, 60_000)?.user_id).toBe(BOB);
    expect(claimNext(db, T0, 60_000)?.user_id).toBe(ALICE);
    db.close();
  });

  test("never claims a done or failed job", () => {
    const db = freshDb();
    insertItem(db, makeItem(ITEM_A, ALICE, "A title"));
    enqueueFetch(db, makeRequest({ id: requestId(1), user_id: ALICE }));
    enqueueFetch(db, makeRequest({ id: requestId(2), user_id: ALICE }));
    const first = claimNext(db, T0, 60_000)!;
    const second = claimNext(db, T0, 60_000)!;
    expect(completeFetch(db, first.id, first.attempts, ITEM_A)).toBe(true);
    expect(failFetch(db, second.id, second.attempts, "ACQUIRE_FAILED")).toBe(true);

    expect(claimNext(db, T0, 60_000)).toBeNull();
    db.close();
  });

  test("throws STORE_BUSY rather than returning null when a write conflicts", async () => {
    // A deferred transaction that reads, then upgrades to a write after
    // another connection committed, fails with SQLITE_BUSY_SNAPSHOT, and
    // busy_timeout does not retry that class of error. `null` must keep
    // meaning "the queue is empty" and nothing else, and the raw SQLiteError
    // must not leave L2.
    const root = await tempRoot();
    const path = join(root, "conflict.db");
    const reader = openDatabase(path, T0);
    const writer = openDatabase(path, T0);
    try {
      insertUser(reader, makeUser(ALICE, "alice"));
      enqueueFetch(reader, makeRequest({ id: requestId(1), user_id: ALICE }));

      reader.exec("BEGIN");
      reader
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM fetch_requests")
        .get();
      writer.run(
        "INSERT INTO fetch_requests (id, user_id, item_id, url, state, lease_expires_at, attempts, error_code, created_at) VALUES (?, ?, NULL, 'https://example.com', 'queued', NULL, 0, NULL, ?)",
        [requestId(2), ALICE, "2026-02-02T00:00:00.000Z"],
      );

      expect(caughtAppErrorCode(() => claimNext(reader, T0, 60_000))).toBe(
        "STORE_BUSY",
      );
    } finally {
      try {
        reader.exec("ROLLBACK");
      } catch {
        // The transaction may already be gone. The assertion above is the test.
      }
      reader.close();
      writer.close();
    }

    const after = openDatabase(path, T0);
    expect(rawRequest(after, requestId(1))!.state).toBe("queued");
    after.close();
  });

  test("claims with one UPDATE ... RETURNING and no separate SELECT", async () => {
    const source = await Bun.file(join(repoRoot, "src", "store", "queue.ts")).text();
    const normalized = source.replaceAll(/\s+/g, " ");

    const claims = [
      ...normalized.matchAll(
        /UPDATE fetch_requests SET state\s*=\s*'claimed'.*?RETURNING\s*\*/g,
      ),
    ].map((match) => match[0]);
    // claimNext picks the oldest queued row and claimRequest claims one named
    // row. Both are single statements, so neither can race a concurrent
    // claimer into double-claiming the row.
    expect(claims).toHaveLength(2);

    const claimNext = claims.find((claim) =>
      claim.includes("SELECT id FROM fetch_requests"),
    );
    expect(claimNext).toBeDefined();
    expect(claimNext).toMatch(/state\s*=\s*'queued'/);
    expect(claimNext).toMatch(/ORDER BY created_at\s*,\s*id/);
    expect(claimNext).toMatch(/LIMIT 1/);
    expect(claimNext).toMatch(/attempts\s*=\s*attempts\s*\+\s*1/);

    const claimRequest = claims.find(
      (claim) => !claim.includes("SELECT id FROM fetch_requests"),
    );
    expect(claimRequest).toMatch(/WHERE id\s*=\s*\?\s*AND state\s*=\s*'queued'/);
    expect(claimRequest).toMatch(/attempts\s*=\s*attempts\s*\+\s*1/);

    // A SELECT that picks the job and an UPDATE that claims it are two
    // statements, so two workers could pick the same row.
    const rest = normalized
      .split(claimNext!).join(" ")
      .split(claimRequest!).join(" ");
    expect(rest).not.toMatch(/SELECT id FROM fetch_requests/);
  });
});

describe("src/store/queue completeFetch and failFetch", () => {
  test("completeFetch marks the job done, records the item, and clears the lease", () => {
    const db = freshDb();
    insertItem(db, makeItem(ITEM_A, ALICE, "A title"));
    enqueueFetch(db, makeRequest({ id: requestId(1), user_id: ALICE }));
    const claimed = claimNext(db, T0, 60_000)!;
    expect(claimed.lease_expires_at).not.toBeNull();

    expect(completeFetch(db, claimed.id, claimed.attempts, ITEM_A)).toBe(true);

    const stored = rawRequest(db, requestId(1))!;
    expect(stored.state).toBe("done");
    expect(stored.item_id).toBe(ITEM_A);
    expect(stored.error_code).toBeNull();
    expect(stored.lease_expires_at).toBeNull();
    db.close();
  });

  test("failFetch marks the job failed, records the code, and clears the lease", () => {
    const db = freshDb();
    enqueueFetch(db, makeRequest({ id: requestId(1), user_id: ALICE }));
    const claimed = claimNext(db, T0, 60_000)!;

    expect(failFetch(db, claimed.id, claimed.attempts, "ACQUIRE_FAILED")).toBe(true);

    const stored = rawRequest(db, requestId(1))!;
    expect(stored.state).toBe("failed");
    expect(stored.error_code).toBe("ACQUIRE_FAILED");
    expect(stored.lease_expires_at).toBeNull();
    db.close();
  });

  test("a worker that lost its lease cannot complete the job", () => {
    // Worker A claims the job at attempts 1 and hangs. The sweep requeues it.
    // Worker B claims it at attempts 2. A must not commit over B.
    const db = freshDb();
    insertItem(db, makeItem(ITEM_A, ALICE, "A's item"));
    insertItem(db, makeItem(ITEM_B, ALICE, "B's item"));
    enqueueFetch(db, makeRequest({ id: requestId(1), user_id: ALICE }));

    const workerA = claimNext(db, T0, 60_000)!;
    expect(workerA.attempts).toBe(1);

    const swept = sweepStaleLeases(db, new Date("2026-02-01T00:02:00.000Z"));
    expect(swept.requeued).toEqual([requestId(1)]);

    const workerB = claimNext(db, new Date("2026-02-01T00:03:00.000Z"), 60_000)!;
    expect(workerB.attempts).toBe(2);

    expect(completeFetch(db, workerA.id, workerA.attempts, ITEM_A)).toBe(false);

    const stored = rawRequest(db, requestId(1));
    expect(stored.state).toBe("claimed");
    expect(stored.item_id).toBeNull();
    expect(stored.attempts).toBe(2);

    expect(completeFetch(db, workerB.id, workerB.attempts, ITEM_B)).toBe(true);
    expect(rawRequest(db, requestId(1)).item_id).toBe(ITEM_B);
    db.close();
  });

  test("a worker that lost its lease cannot fail the job", () => {
    const db = freshDb();
    enqueueFetch(db, makeRequest({ id: requestId(1), user_id: ALICE }));

    const workerA = claimNext(db, T0, 60_000)!;
    sweepStaleLeases(db, new Date("2026-02-01T00:02:00.000Z"));
    const workerB = claimNext(db, new Date("2026-02-01T00:03:00.000Z"), 60_000)!;

    expect(failFetch(db, workerA.id, workerA.attempts, "ACQUIRE_TIMEOUT")).toBe(
      false,
    );

    const stored = rawRequest(db, requestId(1));
    expect(stored.state).toBe("claimed");
    expect(stored.error_code).toBeNull();
    expect(workerB.attempts).toBe(2);
    db.close();
  });

  test("neither call touches a job that is not claimed", () => {
    const db = freshDb();
    insertItem(db, makeItem(ITEM_A, ALICE, "A title"));
    enqueueFetch(db, makeRequest({ id: requestId(1), user_id: ALICE }));

    expect(completeFetch(db, requestId(1), 0, ITEM_A)).toBe(false);
    expect(failFetch(db, requestId(1), 0, "ACQUIRE_FAILED")).toBe(false);
    expect(rawRequest(db, requestId(1)).state).toBe("queued");
    db.close();
  });

  test("neither call touches an unknown job", () => {
    const db = freshDb();
    insertItem(db, makeItem(ITEM_A, ALICE, "A title"));
    expect(completeFetch(db, requestId(9), 1, ITEM_A)).toBe(false);
    expect(failFetch(db, requestId(9), 1, "ACQUIRE_FAILED")).toBe(false);
    db.close();
  });
});

describe("src/store/queue sweepStaleLeases", () => {
  test("leaves a live lease alone", () => {
    const db = freshDb();
    enqueueFetch(db, makeRequest({ id: requestId(1), user_id: ALICE }));
    claimNext(db, T0, 60_000);

    const swept = sweepStaleLeases(db, new Date("2026-02-01T00:00:30.000Z"));
    expect(swept.requeued).toEqual([]);
    expect(swept.failed).toEqual([]);

    const stored = rawRequest(db, requestId(1));
    expect(stored.state).toBe("claimed");
    expect(stored.attempts).toBe(1);
    expect(stored.lease_expires_at).toBe("2026-02-01T00:01:00.000Z");
    db.close();
  });

  test("leaves a queued job alone", () => {
    const db = freshDb();
    enqueueFetch(db, makeRequest({ id: requestId(1), user_id: ALICE }));

    const swept = sweepStaleLeases(db, new Date("2027-01-01T00:00:00.000Z"));
    expect(swept.requeued).toEqual([]);
    expect(swept.failed).toEqual([]);
    expect(rawRequest(db, requestId(1)).state).toBe("queued");
    db.close();
  });

  test("requeues an expired lease below MAX_ATTEMPTS, then fails it at MAX_ATTEMPTS", () => {
    const db = freshDb();
    enqueueFetch(db, makeRequest({ id: requestId(1), user_id: ALICE }));

    // Attempt 1 expires exactly at the sweep time, which counts as stale.
    expect(claimNext(db, T0, 60_000)!.attempts).toBe(1);
    const first = sweepStaleLeases(db, new Date("2026-02-01T00:01:00.000Z"));
    expect(first.requeued).toEqual([requestId(1)]);
    expect(first.failed).toEqual([]);
    expect(rawRequest(db, requestId(1)).state).toBe("queued");
    expect(rawRequest(db, requestId(1)).attempts).toBe(1);

    // Attempt 2 expires before the sweep time.
    const t1 = new Date("2026-02-01T01:00:00.000Z");
    expect(claimNext(db, t1, 60_000)!.attempts).toBe(2);
    const second = sweepStaleLeases(db, new Date("2026-02-01T02:00:00.000Z"));
    expect(second.requeued).toEqual([requestId(1)]);
    expect(second.failed).toEqual([]);
    expect(rawRequest(db, requestId(1)).attempts).toBe(2);

    // Attempt 3 reaches MAX_ATTEMPTS, so the next sweep fails the job.
    const t2 = new Date("2026-02-01T03:00:00.000Z");
    const third = claimNext(db, t2, 60_000)!;
    expect(third.attempts).toBe(MAX_ATTEMPTS);

    const last = sweepStaleLeases(db, new Date("2026-02-01T04:00:00.000Z"));
    expect(last.failed).toEqual([requestId(1)]);
    expect(last.requeued).toEqual([]);

    const stored = rawRequest(db, requestId(1));
    expect(stored.state).toBe("failed");
    expect(stored.error_code).toBe("INGEST_ATTEMPTS_EXHAUSTED");
    expect(stored.attempts).toBe(MAX_ATTEMPTS);

    // A failed job never comes back.
    expect(claimNext(db, new Date("2026-02-01T05:00:00.000Z"), 60_000)).toBeNull();
    db.close();
  });

  test("returns both lists in one sweep", () => {
    const db = freshDb();
    // `requestId(1)` exhausts its attempts, `requestId(2)` has one attempt,
    // and `requestId(3)` has an active lease.
    enqueueFetch(
      db,
      makeRequest({
        id: requestId(1),
        user_id: ALICE,
        created_at: "2026-02-01T00:00:00.000Z",
      }),
    );
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      claimNext(db, T0, 60_000);
      if (attempt < MAX_ATTEMPTS - 1) {
        sweepStaleLeases(db, new Date("2026-02-01T00:02:00.000Z"));
      }
    }
    expect(rawRequest(db, requestId(1)).attempts).toBe(MAX_ATTEMPTS);

    enqueueFetch(
      db,
      makeRequest({
        id: requestId(2),
        user_id: BOB,
        created_at: "2026-02-01T00:03:00.000Z",
      }),
    );
    expect(claimNext(db, new Date("2026-02-01T00:04:00.000Z"), 60_000)!.id).toBe(
      requestId(2),
    );

    enqueueFetch(
      db,
      makeRequest({
        id: requestId(3),
        user_id: ALICE,
        created_at: "2026-02-01T00:05:00.000Z",
      }),
    );
    expect(
      claimNext(db, new Date("2026-02-01T00:06:00.000Z"), 3_600_000)!.id,
    ).toBe(requestId(3));

    const swept = sweepStaleLeases(db, new Date("2026-02-01T00:10:00.000Z"));
    expect(swept.requeued).toEqual([requestId(2)]);
    expect(swept.failed).toEqual([requestId(1)]);

    expect(rawRequest(db, requestId(3)).state).toBe("claimed");
    expect(rawRequest(db, requestId(2)).state).toBe("queued");
    expect(rawRequest(db, requestId(1)).state).toBe("failed");
    expect(rawRequest(db, requestId(1)).error_code).toBe(
      "INGEST_ATTEMPTS_EXHAUSTED",
    );
    db.close();
  });
});

describe("src/store/fts", () => {
  test("indexes the blocks of an item and finds one again", () => {
    const db = seededFtsDb();
    indexBlocks(db, ITEM_A, aliceBlocks());

    const hits = searchBlocks(db, ALICE, "wombat", 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.item_id).toBe(ITEM_A);
    expect(hits[0]!.block_index).toBe(1);
    expect(hits[0]!.start_offset).toBe(44);
    expect(hits[0]!.end_offset).toBe(69);
    expect(hits[0]!.is_content).toBe(true);
    expect(typeof hits[0]!.rank).toBe("number");
    db.close();
  });

  test("carries is_content through as a boolean", () => {
    // Milestone 8 filters on it, so it must come back as a boolean, not as
    // the 0 or 1 SQLite stores.
    const db = seededFtsDb();
    indexBlocks(db, ITEM_A, [
      blockRow({ block_index: 0, text: "A wombat digs a burrow." }),
      blockRow({
        block_index: 1,
        start_offset: 30,
        end_offset: 50,
        is_content: false,
        text: "Advertisement: buy a wombat today.",
      }),
    ]);

    const hits = searchBlocks(db, ALICE, "wombat", 10);
    expect(hits).toHaveLength(2);
    const flags = hits
      .toSorted((a, b) => a.block_index - b.block_index)
      .map((hit) => hit.is_content);
    expect(flags).toEqual([true, false]);
    db.close();
  });

  test("marks the hit with the two control characters, not with HTML", () => {
    const db = seededFtsDb();
    indexBlocks(db, ITEM_A, aliceBlocks());

    const hits = searchBlocks(db, ALICE, "wombat", 10);
    expect(hits).toHaveLength(1);
    const snippet = hits[0]!.snippet;
    expect(snippet).toContain(`${MARK_OPEN}wombat${MARK_CLOSE}`);
    expect(snippet).not.toContain("<mark>");
    expect(snippet).not.toContain("</mark>");
    db.close();
  });

  test("returns page text unchanged, adding no markup of its own", () => {
    // The block text comes from a captured page. L2 hands it back byte for
    // byte and src/web/ escapes it. Escaping here would double-escape it.
    const db = seededFtsDb();
    indexBlocks(db, ITEM_A, [
      blockRow({
        block_index: 0,
        text: 'A <script>alert("x")</script> wombat & friends.',
      }),
    ]);

    const hits = searchBlocks(db, ALICE, "wombat", 10);
    expect(hits).toHaveLength(1);
    const snippet = hits[0]!.snippet;
    expect(snippet).toContain("<script>");
    expect(snippet).toContain("&");
    expect(snippet).not.toContain("&lt;");
    expect(snippet).not.toContain("&amp;");
    db.close();
  });

  test("matches a phrase that a run boundary would have split", () => {
    // A run is one text node, so `<em>` splits a phrase across three runs and
    // no phrase query could ever match. A block is paragraph-sized.
    const db = seededFtsDb();
    indexBlocks(db, ITEM_A, [
      blockRow({
        block_index: 0,
        text: "The quick brown fox jumps over the lazy dog.",
      }),
    ]);

    expect(searchBlocks(db, ALICE, '"quick brown fox"', 10)).toHaveLength(1);
    expect(searchBlocks(db, ALICE, '"brown quick fox"', 10)).toEqual([]);
    db.close();
  });

  test("returns an empty array when nothing matches", () => {
    const db = seededFtsDb();
    indexBlocks(db, ITEM_A, aliceBlocks());
    expect(searchBlocks(db, ALICE, "aardvark", 10)).toEqual([]);
    db.close();
  });

  test("re-indexing an item replaces its blocks instead of adding them", () => {
    const db = seededFtsDb();
    indexBlocks(db, ITEM_A, aliceBlocks());
    expect(blockCount(db, ITEM_A)).toBe(2);

    indexBlocks(db, ITEM_A, aliceBlocks());
    expect(blockCount(db, ITEM_A)).toBe(2);
    expect(searchBlocks(db, ALICE, "wombat", 10)).toHaveLength(1);

    indexBlocks(db, ITEM_A, [
      blockRow({ block_index: 0, text: "One wombat only, and nothing else." }),
    ]);
    expect(blockCount(db, ITEM_A)).toBe(1);
    const hits = searchBlocks(db, ALICE, "wombat", 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.block_index).toBe(0);
    db.close();
  });

  test("indexing an empty block list clears the item", () => {
    const db = seededFtsDb();
    indexBlocks(db, ITEM_A, aliceBlocks());
    expect(blockCount(db, ITEM_A)).toBe(2);

    indexBlocks(db, ITEM_A, []);
    expect(blockCount(db, ITEM_A)).toBe(0);
    expect(searchBlocks(db, ALICE, "wombat", 10)).toEqual([]);
    db.close();
  });

  test("accepts a block list whose every item_id matches the argument", () => {
    const db = seededFtsDb();
    const blocks = aliceBlocks();
    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks) {
      expect(String(block.item_id)).toBe(String(ITEM_A));
    }

    expect(() => indexBlocks(db, ITEM_A, blocks)).not.toThrow();
    expect(blockCount(db, ITEM_A)).toBe(blocks.length);
    db.close();
  });

  test("throws STORE_CONSTRAINT_FAILED when one block names another item", () => {
    // The call deletes every row for `itemId` and inserts the list. A block
    // that names a different item would delete one item's rows and insert
    // another's, which crosses items and, with two users, crosses tenants.
    const db = seededFtsDb();
    indexBlocks(db, ITEM_A, aliceBlocks());
    indexBlocks(db, ITEM_B, bobBlocks());
    expect(blockCount(db, ITEM_A)).toBe(2);
    expect(blockCount(db, ITEM_B)).toBe(1);

    const mixed = [
      blockRow({ block_index: 0, text: "A fresh block for this item." }),
      blockRow({
        item_id: ITEM_B,
        user_id: BOB,
        block_index: 1,
        text: "A wombat that belongs to somebody else.",
      }),
      blockRow({ block_index: 2, text: "Another fresh block for this item." }),
    ];

    const error = caught(() => indexBlocks(db, ITEM_A, mixed));
    expect(isAppError(error)).toBe(true);
    expect((error as AppError).code).toBe("STORE_CONSTRAINT_FAILED");

    // The delete and the insert share one transaction, so a rejected call
    // leaves both items exactly as they were.
    expect(blockCount(db, ITEM_A)).toBe(2);
    expect(blockCount(db, ITEM_B)).toBe(1);
    expect(searchBlocks(db, ALICE, "wombat", 10)).toHaveLength(1);
    expect(searchBlocks(db, ALICE, "fresh", 10)).toEqual([]);
    expect(searchBlocks(db, BOB, "wombat", 10)).toHaveLength(1);
    db.close();
  });

  test("re-indexing one item leaves another item alone", () => {
    const db = seededFtsDb();
    indexBlocks(db, ITEM_A, aliceBlocks());
    indexBlocks(db, ITEM_B, bobBlocks());
    expect(blockCount(db, ITEM_B)).toBe(1);

    indexBlocks(db, ITEM_A, aliceBlocks());
    expect(blockCount(db, ITEM_B)).toBe(1);
    expect(searchBlocks(db, BOB, "wombat", 10)).toHaveLength(1);
    db.close();
  });

  test("one user's search never returns another user's block", () => {
    const db = seededFtsDb();
    indexBlocks(db, ITEM_A, aliceBlocks());
    indexBlocks(db, ITEM_B, bobBlocks());

    const forAlice = searchBlocks(db, ALICE, "wombat", 10);
    expect(forAlice).toHaveLength(1);
    expect(forAlice[0]!.item_id).toBe(ITEM_A);

    const forBob = searchBlocks(db, BOB, "wombat", 10);
    expect(forBob).toHaveLength(1);
    expect(forBob[0]!.item_id).toBe(ITEM_B);
    db.close();
  });

  test("honours the limit and orders by rank", () => {
    const db = seededFtsDb();
    indexBlocks(db, ITEM_A, [
      blockRow({ block_index: 0, text: "A wombat digs a burrow." }),
      blockRow({ block_index: 1, text: "Another wombat digs another burrow." }),
      blockRow({
        block_index: 2,
        text: "A wombat, a wombat, and one more wombat.",
      }),
    ]);

    expect(searchBlocks(db, ALICE, "wombat", 10)).toHaveLength(3);

    const limited = searchBlocks(db, ALICE, "wombat", 2);
    expect(limited).toHaveLength(2);
    expect(limited[0]!.rank).toBeLessThanOrEqual(limited[1]!.rank);
    db.close();
  });
});

describe("store writes on a readonly database", () => {
  // `translate` returns `AppError`, so non-constraint failures can't leave L2
  // as raw driver errors. A read-only connection triggers this failure.
  async function readonlyDb(name: string): Promise<Database> {
    const path = await tempRoot().then((root) => join(root, name));
    const seed = openDatabase(path, T0);
    insertUser(seed, makeUser(ALICE, "alice"));
    insertItem(seed, makeItem(ITEM_A, ALICE, "A title"));
    enqueueFetch(seed, makeRequest({ id: requestId(1), user_id: ALICE }));
    claimNext(seed, T0, 60_000);
    seed.close();
    return new Database(path, { readonly: true });
  }

  function expectWriteFailed(run: () => unknown): void {
    const error = caught(run);
    expect(isAppError(error)).toBe(true);
    expect((error as AppError).code).toBe("STORE_WRITE_FAILED");
  }

  test("queue.ts wraps the failure", async () => {
    const db = await readonlyDb("queue.db");
    // The reads still work, so each failure below comes from the write.
    expect(rawRequest(db, requestId(1))!.state).toBe("claimed");

    expectWriteFailed(() =>
      enqueueFetch(db, makeRequest({ id: requestId(2), user_id: ALICE })),
    );
    expectWriteFailed(() => claimNext(db, T0, 60_000));
    expectWriteFailed(() => completeFetch(db, requestId(1), 1, ITEM_A));
    expectWriteFailed(() => failFetch(db, requestId(1), 1, "ACQUIRE_FAILED"));
    expectWriteFailed(() =>
      sweepStaleLeases(db, new Date("2026-02-02T00:00:00.000Z")),
    );
    db.close();
  });

  test("fts.ts wraps the failure", async () => {
    const db = await readonlyDb("fts.db");
    expect(searchBlocks(db, ALICE, "wombat", 10)).toEqual([]);

    expectWriteFailed(() => indexBlocks(db, ITEM_A, aliceBlocks()));
    db.close();
  });
});

describe("src/store/files layout", () => {
  test("itemDir joins the root, the user, and the item", () => {
    expect(itemDir("/var/lib/commonplace/items", ALICE, ITEM_A)).toBe(
      join("/var/lib/commonplace/items", ALICE, ITEM_A),
    );
  });

  test("writeItemFile creates the directory and readItemFile reads it back", async () => {
    const root = await tempRoot();
    await writeItemFile(root, ALICE, ITEM_A, "transcript.txt", "one\ntwo\n");

    expect(existsSync(join(root, ALICE, ITEM_A, "transcript.txt"))).toBe(true);
    expect(await readItemFile(root, ALICE, ITEM_A, "transcript.txt")).toBe(
      "one\ntwo\n",
    );
  });

  test("writeItemFile accepts bytes", async () => {
    const root = await tempRoot();
    await writeItemFile(
      root,
      ALICE,
      ITEM_A,
      "map.json",
      new TextEncoder().encode('{"runs":[]}'),
    );
    expect(await readItemFile(root, ALICE, ITEM_A, "map.json")).toBe('{"runs":[]}');
  });

  test("the temporary name is .tmp-<pid>-<n> in the item directory", async () => {
    // A rename is atomic only inside one directory, so the temporary name
    // must never come from the system temporary directory. The counter, not
    // the clock and not randomness, is what makes the name unique.
    const source = await Bun.file(join(repoRoot, "src", "store", "files.ts")).text();
    expect(source).toMatch(/\brename\b/);
    expect(source).toContain(".tmp-");
    expect(source).toContain("process.pid");
    expect(source).not.toContain("tmpdir");
    expect(source).not.toContain("node:os");
    expect(source).not.toContain('"/tmp');
  });
});

describe("src/store/files path checking", () => {
  // The `as*` functions reject each value below. Cast them here to represent
  // unchecked values from a storage boundary. `files.ts` validates IDs again
  // before it accesses the file system, which prevents directory traversal.
  function untrustedUserId(value: string): UserId {
    return value as UserId;
  }

  function untrustedItemId(value: string): ItemId {
    return value as ItemId;
  }

  const badIds = [
    "../../etc/passwd",
    "..",
    ".",
    "",
    "alice",
    "not a uuid at all okay okay okay okay",
    `${ALICE}/../${BOB}`,
    "/etc/passwd",
    "aaaaaaaa-0000-4000-8000-00000000000g",
    "aaaaaaaa00004000800000000000000 1",
  ];

  test("itemDir rejects a bad user id and a bad item id", () => {
    expect(badIds.length).toBeGreaterThan(0);
    for (const bad of badIds) {
      expect(
        caughtAppErrorCode(() => itemDir("/items", untrustedUserId(bad), ITEM_A)),
      ).toBe("STORE_INVALID_PATH");
      expect(
        caughtAppErrorCode(() => itemDir("/items", ALICE, untrustedItemId(bad))),
      ).toBe("STORE_INVALID_PATH");
    }
  });

  test("itemDir rejects an uppercase UUID", () => {
    // Two ids that differ only in case would collide on a case-insensitive
    // filesystem, and IDs are lowercase UUIDs. ITEM_A holds letters, so
    // upper-casing it really does change it.
    const shouted = ITEM_A.toUpperCase();
    expect(shouted).not.toBe(String(ITEM_A));
    expect(
      caughtAppErrorCode(() => itemDir("/items", ALICE, untrustedItemId(shouted))),
    ).toBe("STORE_INVALID_PATH");
    expect(
      caughtAppErrorCode(() => itemDir("/items", untrustedUserId(shouted), ITEM_A)),
    ).toBe("STORE_INVALID_PATH");
    expect(
      caughtAppErrorCode(() =>
        itemDir(
          "/items",
          ALICE,
          untrustedItemId("AAAAAAAA-0000-4000-8000-000000000001"),
        ),
      ),
    ).toBe("STORE_INVALID_PATH");
  });

  test("itemDir accepts a lowercase UUID", () => {
    expect(() => itemDir("/items", ALICE, ITEM_A)).not.toThrow();
    expect(() => itemDir("/items", BOB, ITEM_D)).not.toThrow();
  });

  test("writeItemFile rejects a traversal id and writes nothing", async () => {
    const root = await tempRoot();
    expect(
      await rejectedAppErrorCode(() =>
        writeItemFile(
          root,
          untrustedUserId("../../etc"),
          ITEM_A,
          "transcript.txt",
          "x",
        ),
      ),
    ).toBe("STORE_INVALID_PATH");
    expect(
      await rejectedAppErrorCode(() =>
        writeItemFile(
          root,
          ALICE,
          untrustedItemId("../../etc/passwd"),
          "transcript.txt",
          "x",
        ),
      ),
    ).toBe("STORE_INVALID_PATH");

    expect(await readdir(root)).toEqual([]);
  });

  test("every file call rejects a traversal id", async () => {
    const root = await tempRoot();
    const escape = untrustedItemId("../../etc/passwd");
    expect(
      await rejectedAppErrorCode(() =>
        readItemFile(root, ALICE, escape, "transcript.txt"),
      ),
    ).toBe("STORE_INVALID_PATH");
    expect(await readdir(root)).toEqual([]);
  });
});

describe("src/store/files sweepOrphans", () => {
  test("deletes unknown item directories and keeps the known ones", async () => {
    const root = await tempRoot();
    await writeItemFile(root, ALICE, ITEM_A, "transcript.txt", "keep");
    await writeItemFile(root, ALICE, ITEM_B, "transcript.txt", "drop");
    await writeItemFile(root, BOB, ITEM_C, "transcript.txt", "drop");

    const deleted = await sweepOrphans(
      root,
      new Set([`${ALICE}/${ITEM_A}`]),
      FAR_AHEAD,
    );

    expect(deleted).toEqual(
      [join(root, ALICE, ITEM_B), join(root, BOB, ITEM_C)].toSorted(),
    );

    expect(existsSync(join(root, ALICE, ITEM_A))).toBe(true);
    expect(existsSync(join(root, ALICE, ITEM_B))).toBe(false);
    expect(existsSync(join(root, BOB, ITEM_C))).toBe(false);
  });

  test("skips a directory that changed at or after olderThan", async () => {
    // The sweep races an ingest in flight: the worker has written a file but
    // has not committed the row, so the id is not in `known` yet.
    const root = await tempRoot();
    await writeItemFile(root, ALICE, ITEM_A, "original.html", "<p>in flight</p>");

    const deleted = await sweepOrphans(root, new Set<string>(), LONG_AGO);

    expect(deleted).toEqual([]);
    expect(existsSync(join(root, ALICE, ITEM_A))).toBe(true);
  });

  test("never deletes a user directory", async () => {
    const root = await tempRoot();
    await writeItemFile(root, ALICE, ITEM_A, "transcript.txt", "drop");
    await mkdir(join(root, BOB), { recursive: true });

    const deleted = await sweepOrphans(root, new Set<string>(), FAR_AHEAD);

    expect(deleted).toEqual([join(root, ALICE, ITEM_A)]);
    expect(existsSync(join(root, ALICE))).toBe(true);
    expect(existsSync(join(root, BOB))).toBe(true);
    expect(existsSync(join(root, ALICE, ITEM_A))).toBe(false);
  });

  test("deletes nothing when every item directory is known", async () => {
    const root = await tempRoot();
    await writeItemFile(root, ALICE, ITEM_A, "transcript.txt", "keep");
    await writeItemFile(root, BOB, ITEM_B, "transcript.txt", "keep");

    const deleted = await sweepOrphans(
      root,
      new Set([`${ALICE}/${ITEM_A}`, `${BOB}/${ITEM_B}`]),
      FAR_AHEAD,
    );

    expect(deleted).toEqual([]);
    expect(existsSync(join(root, ALICE, ITEM_A))).toBe(true);
    expect(existsSync(join(root, BOB, ITEM_B))).toBe(true);
  });

  test("leaves a loose file in the root alone", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "README"), "not an item\n");
    await writeItemFile(root, ALICE, ITEM_A, "transcript.txt", "keep");

    const deleted = await sweepOrphans(
      root,
      new Set([`${ALICE}/${ITEM_A}`]),
      FAR_AHEAD,
    );

    expect(deleted).toEqual([]);
    expect(existsSync(join(root, "README"))).toBe(true);
  });
});
