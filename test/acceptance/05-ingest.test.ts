// Acceptance test for milestone 5. It is the specification for that work.
// Change it only when the design changes, and say what changed and why.
//
// What the implementer must create
// --------------------------------
// The ingest service and reusable worker keep file writes ahead of the item
// commit and fence work with queue leases.
//
// Contract details this file pins down
// ------------------------------------
// The specification leaves these open. This file settles them.
//
// - `ingestRequest` returns an outcome. It never marks a request failed or
//   queued itself. `drainOnce` owns that decision.
// - The orphan sweep protects a directory named by a `queued` or `claimed`
//   request, and collects one named only by a `failed` request.
// - `sweep` runs its three steps in one pass, so a request that runs out of
//   attempts is failed and its directory collected by the same call.
//
// The clock
// ---------
// The fake clock starts at the real current time, not at a fixed literal.
// The orphan sweep compares a cutoff against real filesystem mtimes, so a
// clock anchored in 2026-01-01 would find every directory "in the future" and
// collect nothing. Tests advance the clock; nothing asserts an exact
// timestamp.
//
// The real capture tool
// ---------------------
// The last test drives the real `single-file` binary against a `file://` URL.
// It needs a browser, so it runs only when `CP_REAL_CAPTURE=1` is set and the
// binary is on PATH. It is not part of the default gate.

import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addMs, now } from "../../src/contracts/clock";
import { AppError } from "../../src/contracts/errors";
import { asUserId, newItemId, newRequestId } from "../../src/contracts/ids";
import type { ItemId, UserId } from "../../src/contracts/ids";
import type { FetchRequest, User } from "../../src/contracts/item";
import { validateMap } from "../../src/contracts/transcript";
import { sanitize } from "../../src/core/sanitize";
import { metadata, walk } from "../../src/core/walk";
import { DEFAULT_TIMEOUT_MS } from "../../src/services/acquire";
import type { CaptureRequest, CaptureResult } from "../../src/services/acquire";
import { ingestRequest } from "../../src/services/ingest";
import { LEASE_MS, drainOnce, sweep } from "../../src/services/worker";
import type { WorkerDeps } from "../../src/services/worker";
import { openDatabase } from "../../src/store/db";
import {
  itemDir,
  readItemFile,
} from "../../src/store/files";
import { searchBlocks } from "../../src/store/fts";
import { getItem, itemPaths, listItems } from "../../src/store/items";
import {
  MAX_ATTEMPTS,
  claimNext,
  enqueueFetch,
  pendingItemPaths,
  sweepStaleLeases,
} from "../../src/store/queue";
import { insertUser } from "../../src/store/users";

const repoRoot = join(import.meta.dir, "..", "..");

const ALICE = asUserId("11111111-1111-4111-8111-111111111111");
const BOB = asUserId("22222222-2222-4222-8222-222222222222");

const PAGE = `<!DOCTYPE html><html><head>
<meta property="og:title" content="The Open Graph Title">
<meta name="author" content="Ada Lovelace">
<title>The Document Title</title></head>
<body><article><h1>A Heading</h1>
<p>First paragraph with <em>emphasis</em> inside it.</p>
<p>Second paragraph about looms and engines and analytical machines.</p>
<p>Third paragraph gives Readability enough prose to classify the article content.</p>
</article><nav><a href="/x">Nav link</a></nav></body></html>`;

const SECOND_PAGE = PAGE.replace(
  "The Open Graph Title",
  "The Second Capture Title",
);

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

type Env = {
  db: Database;
  dbPath: string;
  itemsRoot: string;
  at: Date;
};

function makeUser(id: UserId, subject: string): User {
  return {
    id,
    subject,
    email: `${subject}@example.com`,
    created_at: new Date("2026-01-01T00:00:00.000Z").toISOString(),
  };
}

async function freshEnv(name: string): Promise<Env> {
  const root = await mkdtemp(join(tmpdir(), `commonplace-ingest-${name}-`));
  roots.push(root);
  const itemsRoot = join(root, "items");
  await mkdir(itemsRoot, { recursive: true });
  const dbPath = join(root, "db.sqlite");
  const at = now();
  const db = openDatabase(dbPath, at);
  insertUser(db, makeUser(ALICE, "alice"));
  insertUser(db, makeUser(BOB, "bob"));
  return { db, dbPath, itemsRoot, at };
}

function fakeCapture(
  html: string,
): (request: CaptureRequest) => Promise<CaptureResult> {
  return async (request) => {
    await writeFile(request.outputPath, html);
    return { path: request.outputPath, bytes: html.length };
  };
}

function throwingCapture(): (request: CaptureRequest) => Promise<CaptureResult> {
  return async () => {
    throw new AppError("ACQUIRE_FAILED", "the fake capture always fails");
  };
}

function makeDeps(
  env: Env,
  capture: (request: CaptureRequest) => Promise<CaptureResult>,
  overrides: Partial<WorkerDeps> = {},
): WorkerDeps {
  return {
    db: env.db,
    itemsRoot: env.itemsRoot,
    now: () => env.at,
    capture,
    browserPath: "/usr/bin/chromium",
    ...overrides,
  };
}

function queueRequest(
  env: Env,
  overrides: Partial<FetchRequest> & { user_id: UserId },
): FetchRequest {
  return enqueueFetch(env.db, {
    id: newRequestId(),
    item_id: null,
    url: "https://example.com/article",
    state: "queued",
    lease_expires_at: null,
    attempts: 0,
    error_code: null,
    created_at: env.at.toISOString(),
    ...overrides,
  });
}

function requestOf(env: Env, id: string): FetchRequest {
  return env.db
    .query<FetchRequest, [string]>("SELECT * FROM fetch_requests WHERE id = ?")
    .get(id)!;
}

function blockCount(env: Env, itemId: ItemId): number {
  return env.db
    .query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM blocks_fts WHERE item_id = ?",
    )
    .get(itemId)!.n;
}

describe("the happy path", () => {
  test("one queued request becomes an item, four files, and a search index", async () => {
    const env = await freshEnv("happy");
    const request = queueRequest(env, { user_id: ALICE });

    const outcome = await drainOnce(makeDeps(env, fakeCapture(PAGE)));

    expect(outcome).not.toBeNull();
    expect(outcome!.state).toBe("done");
    const itemId = (outcome as { state: "done"; itemId: ItemId }).itemId;

    const settled = requestOf(env, request.id);
    expect(settled.state).toBe("done");
    expect(settled.item_id).toBe(itemId);
    expect(settled.error_code).toBeNull();

    const item = getItem(env.db, ALICE, itemId)!;
    expect(item.url).toBe("https://example.com/article");
    expect(item.title).toBe("The Open Graph Title");
    expect(item.author).toBe("Ada Lovelace");
    expect(item.ingested_at).not.toBeNull();

    expect((await readdir(itemDir(env.itemsRoot, ALICE, itemId))).toSorted()).toEqual([
      "original.html",
      "sanitized.html",
      "transcript.txt",
      "map.json",
    ].toSorted());

    const expected = walk(sanitize(PAGE));
    const transcript = await readItemFile(
      env.itemsRoot,
      ALICE,
      itemId,
      "transcript.txt",
    );
    expect(transcript).toBe(expected.text);

    const map = JSON.parse(
      await readItemFile(env.itemsRoot, ALICE, itemId, "map.json"),
    );
    expect(() => validateMap(map, transcript.length)).not.toThrow();

    expect(blockCount(env, itemId)).toBe(5);

    const hits = searchBlocks(env.db, ALICE, "analytical", 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.item_id).toBe(itemId);
    expect(hits[0]!.is_content).toBe(true);
    expect(
      transcript.slice(hits[0]!.start_offset, hits[0]!.end_offset),
    ).toContain("analytical");

    const navHits = searchBlocks(env.db, ALICE, "link", 10);
    expect(navHits).toHaveLength(1);
    expect(navHits[0]!.is_content).toBe(false);
  });

  test("another tenant sees neither the item nor its blocks", async () => {
    const env = await freshEnv("tenancy");
    queueRequest(env, { user_id: ALICE });
    await drainOnce(makeDeps(env, fakeCapture(PAGE)));

    expect(listItems(env.db, BOB, 10)).toEqual([]);
    expect(searchBlocks(env.db, BOB, "analytical", 10)).toEqual([]);
  });
});

describe("metadata comes from the original, not the sanitized copy", () => {
  test("the sanitizer deletes every meta element", () => {
    const clean = sanitize(PAGE);
    expect(clean).not.toContain("<meta");
    expect(clean).not.toContain("The Open Graph Title");
    expect(clean).toContain("The Document Title");
  });

  test("metadata prefers og:title over title", () => {
    expect(metadata(PAGE)).toEqual({
      title: "The Open Graph Title",
      author: "Ada Lovelace",
    });
  });

  test("metadata on the sanitized copy falls back, which is the bug to avoid", () => {
    expect(metadata(sanitize(PAGE)).title).toBe("The Document Title");
  });

  test("metadata returns null when a page carries neither tag", () => {
    const bare = "<html><body><p>No title anywhere.</p></body></html>";
    expect(metadata(bare)).toEqual({ title: null, author: null });
  });

  test("an ingested item carries the og:title", async () => {
    const env = await freshEnv("metadata");
    queueRequest(env, { user_id: ALICE });
    const outcome = await drainOnce(makeDeps(env, fakeCapture(PAGE)));
    const itemId = (outcome as { state: "done"; itemId: ItemId }).itemId;
    expect(getItem(env.db, ALICE, itemId)!.title).toBe("The Open Graph Title");
  });

  test("a page with no title falls back to the URL", async () => {
    const env = await freshEnv("no-title");
    queueRequest(env, { user_id: ALICE });
    const page =
      "<html><body><p>Enough prose to walk into a real transcript with several words.</p></body></html>";
    const outcome = await drainOnce(makeDeps(env, fakeCapture(page)));
    const itemId = (outcome as { state: "done"; itemId: ItemId }).itemId;
    expect(getItem(env.db, ALICE, itemId)!.title).toBe(
      "https://example.com/article",
    );
  });
});

// The crash tests share one setup. A child Bun process claims a request,
// reserves an item id, writes the four files, and exits before committing.
// Terminate a child process to verify the write order after an actual process
// failure.
async function crashedIngest(
  env: Env,
  reserved: { itemId?: ItemId } = {},
): Promise<{
  request: FetchRequest;
  itemId: ItemId;
  dir: string;
}> {
  const request = queueRequest(env, { user_id: ALICE });
  const itemId = reserved.itemId ?? newItemId();
  const script = join(env.itemsRoot, "..", "crash.ts");
  await writeFile(
    script,
    `import { openDatabase } from ${JSON.stringify(join(repoRoot, "src/store/db"))};
import { claimNext, reserveItem } from ${JSON.stringify(join(repoRoot, "src/store/queue"))};
import { ensureItemDir, writeItemFile } from ${JSON.stringify(join(repoRoot, "src/store/files"))};
import { asItemId, asUserId } from ${JSON.stringify(join(repoRoot, "src/contracts/ids"))};

const [dbPath, itemsRoot, rawItemId, rawUserId, leaseMs, nowIso] =
  process.argv.slice(2) as string[];
const at = new Date(nowIso!);
const db = openDatabase(dbPath!, at);
const userId = asUserId(rawUserId!);
const itemId = asItemId(rawItemId!);
const claimed = claimNext(db, at, Number(leaseMs));
if (claimed === null) process.exit(2);
if (!reserveItem(db, claimed.id, claimed.attempts, itemId)) process.exit(3);
await ensureItemDir(itemsRoot!, userId, itemId);
await writeItemFile(itemsRoot!, userId, itemId, "original.html", "<html></html>");
await writeItemFile(itemsRoot!, userId, itemId, "sanitized.html", "<html></html>");
await writeItemFile(itemsRoot!, userId, itemId, "transcript.txt", "text");
await writeItemFile(itemsRoot!, userId, itemId, "map.json", '{"runs":[]}');
process.exit(1);
`,
  );

  const child = Bun.spawn(
    [
      process.execPath,
      script,
      env.dbPath,
      env.itemsRoot,
      itemId,
      ALICE,
      String(LEASE_MS),
      env.at.toISOString(),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const code = await child.exited;
  if (code !== 1) {
    throw new Error(
      `the crash child exited ${code}: ${await new Response(child.stderr).text()}`,
    );
  }

  return { request, itemId, dir: itemDir(env.itemsRoot, ALICE, itemId) };
}

describe("the crash-safe order", () => {
  test("a crash before the commit leaves a claimed request and no item", async () => {
    const env = await freshEnv("crash");
    const { request, itemId, dir } = await crashedIngest(env);

    const after = requestOf(env, request.id);
    expect(after.state).toBe("claimed");
    expect(after.item_id).toBe(itemId);
    expect(after.attempts).toBe(1);

    expect(existsSync(dir)).toBe(true);
    expect(await readdir(itemDir(env.itemsRoot, ALICE, itemId))).toHaveLength(4);
    expect(getItem(env.db, ALICE, itemId)).toBeNull();
  });

  test("the sweep protects a directory a live request still needs", async () => {
    const env = await freshEnv("protect-live");
    const { itemId, dir } = await crashedIngest(env);

    expect(pendingItemPaths(env.db)).toContain(`${ALICE}/${itemId}`);

    const result = await sweep(
      makeDeps(env, fakeCapture(PAGE), { orphanGraceMs: 0 }),
    );

    expect(result.orphans).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  test("the sweep protects a directory a requeued request will reuse", async () => {
    const env = await freshEnv("protect-requeued");
    const { request, itemId, dir } = await crashedIngest(env);

    env.at = addMs(env.at, LEASE_MS + 1000);
    const result = await sweep(
      makeDeps(env, fakeCapture(PAGE), { orphanGraceMs: 0 }),
    );

    expect(result.requeued).toContain(request.id);
    expect(requestOf(env, request.id)!.state).toBe("queued");
    expect(pendingItemPaths(env.db)).toContain(`${ALICE}/${itemId}`);
    expect(result.orphans).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  test("a retry after a crash reuses the item id and leaves one directory", async () => {
    const env = await freshEnv("retry-reuses");
    const { request, itemId } = await crashedIngest(env);

    env.at = addMs(env.at, LEASE_MS + 1000);
    await sweep(makeDeps(env, fakeCapture(PAGE), { orphanGraceMs: 0 }));

    const outcome = await drainOnce(makeDeps(env, fakeCapture(PAGE)));
    expect(outcome!.state).toBe("done");
    expect((outcome as { state: "done"; itemId: ItemId }).itemId).toBe(itemId);

    expect(requestOf(env, request.id)!.state).toBe("done");
    expect(await readdir(join(env.itemsRoot, ALICE))).toEqual([itemId]);
    expect(itemPaths(env.db)).toEqual([`${ALICE}/${itemId}`]);
  });
});

describe("the lease fence", () => {
  test("a worker that loses its lease mid-capture commits nothing", async () => {
    const env = await freshEnv("fence");
    queueRequest(env, { user_id: ALICE });

    const claimed = claimNext(env.db, env.at, LEASE_MS)!;
    expect(claimed.attempts).toBe(1);

    // The capture "runs" long enough for the lease to expire and a second
    // worker to take the request, which raises attempts to 2.
    const stealingCapture = async (
      request: CaptureRequest,
    ): Promise<CaptureResult> => {
      env.at = addMs(env.at, LEASE_MS + 1000);
      sweepStaleLeases(env.db, env.at);
      const second = claimNext(env.db, env.at, LEASE_MS)!;
      expect(second.attempts).toBe(2);
      await writeFile(request.outputPath, PAGE);
      return { path: request.outputPath, bytes: PAGE.length };
    };

    const outcome = await ingestRequest(
      makeDeps(env, stealingCapture),
      claimed,
    );

    expect(outcome).toEqual({
      state: "failed",
      code: "INGEST_LEASE_LOST",
      message: expect.any(String),
    });
    expect(listItems(env.db, ALICE, 10)).toEqual([]);
    expect(itemPaths(env.db)).toEqual([]);
  });

  test("a stale snapshot cannot even reserve", async () => {
    const env = await freshEnv("fence-reserve");
    queueRequest(env, { user_id: ALICE });

    const first = claimNext(env.db, env.at, LEASE_MS)!;
    env.at = addMs(env.at, LEASE_MS + 1000);
    sweepStaleLeases(env.db, env.at);
    claimNext(env.db, env.at, LEASE_MS);

    const outcome = await ingestRequest(
      makeDeps(env, fakeCapture(PAGE)),
      first,
    );

    expect(outcome.state).toBe("failed");
    expect((outcome as { code: string }).code).toBe("INGEST_LEASE_LOST");
    expect(await readdir(env.itemsRoot)).toEqual([]);
  });
});

describe("retry and exhaustion", () => {
  test("three failed captures requeue twice and then fail for good", async () => {
    const env = await freshEnv("exhaust");
    const request = queueRequest(env, { user_id: ALICE });
    const deps = makeDeps(env, throwingCapture());

    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      const outcome = await drainOnce(deps);
      expect(outcome!.state).toBe("retry");
      const row = requestOf(env, request.id)!;
      expect(row.state).toBe("queued");
      expect(row.attempts).toBe(attempt);
      expect(row.error_code).toBe("ACQUIRE_FAILED");
      expect(row.lease_expires_at).toBeNull();
    }

    const last = await drainOnce(deps);
    expect(last!.state).toBe("retry");
    const row = requestOf(env, request.id)!;
    expect(row.state).toBe("failed");
    expect(row.attempts).toBe(MAX_ATTEMPTS);
    expect(row.error_code).toBe("INGEST_ATTEMPTS_EXHAUSTED");

    expect(await drainOnce(deps)).toBeNull();
    expect(listItems(env.db, ALICE, 10)).toEqual([]);
  });

  test("an empty transcript is a retry, not a permanent failure", async () => {
    const env = await freshEnv("empty");
    const request = queueRequest(env, { user_id: ALICE });

    const outcome = await drainOnce(
      makeDeps(env, fakeCapture("<html><body></body></html>")),
    );

    expect(outcome!.state).toBe("retry");
    expect((outcome as { code: string }).code).toBe("INGEST_EMPTY_TRANSCRIPT");
    expect(requestOf(env, request.id)!.state).toBe("queued");
  });
});

describe("capturing a URL a user already saved", () => {
  test("the second capture updates the item instead of conflicting", async () => {
    const env = await freshEnv("recapture");
    queueRequest(env, { user_id: ALICE });
    const first = await drainOnce(makeDeps(env, fakeCapture(PAGE)));
    const itemId = (first as { state: "done"; itemId: ItemId }).itemId;

    queueRequest(env, { user_id: ALICE });
    const second = await drainOnce(makeDeps(env, fakeCapture(SECOND_PAGE)));

    expect(second!.state).toBe("done");
    expect((second as { state: "done"; itemId: ItemId }).itemId).toBe(itemId);

    expect(listItems(env.db, ALICE, 10)).toHaveLength(1);
    expect(getItem(env.db, ALICE, itemId)!.title).toBe(
      "The Second Capture Title",
    );
    expect(await readdir(join(env.itemsRoot, ALICE))).toEqual([itemId]);
    expect(blockCount(env, itemId)).toBe(5);
  });

  test("a re-capture that crashes once still updates the item on the retry", async () => {
    const env = await freshEnv("recapture-crash");

    // 1. Save a URL. Item X is written and the request finishes.
    queueRequest(env, { user_id: ALICE });
    const first = await drainOnce(makeDeps(env, fakeCapture(PAGE)));
    const itemId = (first as { state: "done"; itemId: ItemId }).itemId;

    // 2. Save the same URL again. The new request finds X, reserves X, and
    //    crashes before the commit.
    const { request } = await crashedIngest(env, { itemId });
    expect(requestOf(env, request.id)!.item_id).toBe(itemId);

    // 3. The lease expires and the request returns to queued.
    env.at = addMs(env.at, LEASE_MS + 1000);
    const swept = await sweep(
      makeDeps(env, fakeCapture(PAGE), { orphanGraceMs: 0 }),
    );
    expect(swept.requeued).toContain(request.id);
    expect(requestOf(env, request.id)!.state).toBe("queued");

    // 4. The retry carries item_id = X and takes the update branch instead
    //    of the insert branch that throws on the UNIQUE index.
    const outcome = await drainOnce(makeDeps(env, fakeCapture(SECOND_PAGE)));
    expect(outcome!.state).toBe("done");
    expect((outcome as { state: "done"; itemId: ItemId }).itemId).toBe(itemId);

    // 5. The item is updated in place, not duplicated or left stale.
    expect(listItems(env.db, ALICE, 10)).toHaveLength(1);
    expect(getItem(env.db, ALICE, itemId)!.title).toBe(
      "The Second Capture Title",
    );
    expect(await readdir(join(env.itemsRoot, ALICE))).toEqual([itemId]);
  });

  test("two users may each hold the same URL", async () => {
    const env = await freshEnv("two-users");
    queueRequest(env, { user_id: ALICE });
    queueRequest(env, { user_id: BOB });

    const deps = makeDeps(env, fakeCapture(PAGE));
    const a = await drainOnce(deps);
    const b = await drainOnce(deps);

    expect(a!.state).toBe("done");
    expect(b!.state).toBe("done");
    expect(listItems(env.db, ALICE, 10)).toHaveLength(1);
    expect(listItems(env.db, BOB, 10)).toHaveLength(1);
    expect(itemPaths(env.db)).toHaveLength(2);
  });
});

describe("the constants agree with each other", () => {
  test("the lease outlasts a capture that runs to its timeout", () => {
    expect(LEASE_MS).toBeGreaterThan(DEFAULT_TIMEOUT_MS);
  });
});

describe("the queue is empty", () => {
  test("drainOnce returns null and touches nothing", async () => {
    const env = await freshEnv("idle");
    expect(await drainOnce(makeDeps(env, fakeCapture(PAGE)))).toBeNull();
    expect(await readdir(env.itemsRoot)).toEqual([]);
  });
});

const realCaptureReady =
  process.env.CP_REAL_CAPTURE === "1" && Bun.which("single-file") !== null;

describe("the real capture tool", () => {
  test.skipIf(!realCaptureReady)(
    "ingests a local file:// page end to end",
    async () => {
      const env = await freshEnv("real");
      const page = join(env.itemsRoot, "..", "page.html");
      await writeFile(page, PAGE);
      queueRequest(env, { user_id: ALICE, url: `file://${page}` });

      const { capture } = await import("../../src/services/acquire");
      const outcome = await drainOnce(makeDeps(env, capture));

      expect(outcome!.state).toBe("done");
      const itemId = (outcome as { state: "done"; itemId: ItemId }).itemId;
      const transcript = await readItemFile(
        env.itemsRoot,
        ALICE,
        itemId,
        "transcript.txt",
      );
      expect(transcript).toContain("analytical machines");
    },
    300_000,
  );
});
