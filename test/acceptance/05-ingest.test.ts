import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addMs, now } from "../../src/contracts/clock";
import { AppError } from "../../src/contracts/errors";
import { asUserId, newItemId, newRequestId } from "../../src/contracts/ids";
import type { ItemId } from "../../src/contracts/ids";
import { parseJsonValue } from "../../src/contracts/item";
import type { FetchRequest, User } from "../../src/contracts/item";
import { validateMap } from "../../src/contracts/transcript";
import type { CaptureRequest, CaptureResult } from "../../src/services/acquire";
import { ingestRequest } from "../../src/services/ingest";
import { drainOnce, sweep } from "../../src/services/worker";
import { openDatabase } from "../../src/store/db";
import { readItemFile, writeItemFile } from "../../src/store/files";
import { searchBlocks } from "../../src/store/fts";
import { getItem, listItems } from "../../src/store/items";
import {
  claimNext,
  enqueueFetch,
  sweepStaleLeases,
} from "../../src/store/queue";
import { insertUser } from "../../src/store/users";

const ALICE = asUserId("11111111-1111-4111-8111-111111111111");
const BOB = asUserId("22222222-2222-4222-8222-222222222222");
const PAGE = `<!DOCTYPE html><html><head><meta property="og:title" content="Saved title"><meta name="author" content="Ada Lovelace"><title>Fallback</title></head><body><article><h1>A saved article</h1><p>First paragraph with enough words to become readable prose.</p><p>Second paragraph about durable transcripts and search.</p></article><nav>Navigation words</nav></body></html>`;
const roots: string[] = [];

type Env = { db: Database; dbPath: string; itemsRoot: string; at: Date };

function user(id: typeof ALICE, subject: string): User {
  return { id, subject, email: null, created_at: new Date("2026-01-01").toISOString() };
}

async function environment(name: string): Promise<Env> {
  const root = await mkdtemp(join(tmpdir(), `commonplace-ingest-${name}-`));
  roots.push(root);
  const itemsRoot = join(root, "items");
  await mkdir(itemsRoot, { recursive: true });
  const at = now();
  const dbPath = join(root, "db.sqlite");
  const db = openDatabase(dbPath, at);
  insertUser(db, user(ALICE, "alice"));
  insertUser(db, user(BOB, "bob"));
  return { db, dbPath, itemsRoot, at };
}

function capture(html: string): (request: CaptureRequest) => Promise<CaptureResult> {
  return async (request) => {
    await Bun.write(request.outputPath, html);
    return { path: request.outputPath, bytes: html.length };
  };
}

async function captureTimeout(): Promise<CaptureResult> {
  throw new AppError("ACQUIRE_TIMEOUT", "capture timed out");
}

function fetchRequest(db: Database, userId: typeof ALICE, id: ReturnType<typeof newRequestId>): FetchRequest | null {
  return db.query<FetchRequest, [string, string]>(
    "SELECT id, user_id, item_id, url, state, lease_expires_at, attempts, error_code, created_at FROM fetch_requests WHERE user_id = ? AND id = ?",
  ).get(userId, id) ?? null;
}

function queue(env: Env, userId: typeof ALICE, itemId: ItemId | null = null) {
  return enqueueFetch(env.db, {
    id: newRequestId(),
    user_id: userId,
    item_id: itemId,
    url: "https://example.com/article",
    state: "queued",
    lease_expires_at: null,
    attempts: 0,
    error_code: null,
    created_at: env.at.toISOString(),
  });
}

function deps(env: Env, captureFn: (request: CaptureRequest) => Promise<CaptureResult>) {
  return { db: env.db, itemsRoot: env.itemsRoot, now: () => env.at, capture: captureFn, browserPath: "/usr/bin/chromium" };
}

async function files(env: Env, userId: typeof ALICE, itemId: ItemId): Promise<string[]> {
  return readdir(join(env.itemsRoot, userId, itemId)).then((entries) => entries.toSorted());
}

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

describe("ingest outcomes", () => {
  test("turns a URL request into durable files, an item, and searchable blocks", async () => {
    const env = await environment("happy");
    const request = queue(env, ALICE);
    const outcome = await drainOnce(deps(env, capture(PAGE)));
    expect(outcome?.state).toBe("done");
    if (outcome?.state !== "done") {
      throw new Error("expected the ingest to complete");
    }
    const itemId = outcome.itemId;
    expect(fetchRequest(env.db, ALICE, request.id)).toMatchObject({ state: "done", item_id: itemId });
    expect(getItem(env.db, ALICE, itemId)).toMatchObject({ title: "Saved title", author: "Ada Lovelace" });
    expect(await files(env, ALICE, itemId)).toEqual([
      "map.json", "original.html", "sanitized.html", "transcript.txt",
    ]);
    const transcript = await readItemFile(env.itemsRoot, ALICE, itemId, "transcript.txt");
    const map = parseJsonValue(await readItemFile(env.itemsRoot, ALICE, itemId, "map.json"));
    expect(transcript).toContain("durable transcripts");
    expect(() => validateMap(map, transcript.length)).not.toThrow();
    expect(searchBlocks(env.db, ALICE, "durable", 10)).toHaveLength(1);
    expect(listItems(env.db, BOB, 10)).toEqual([]);
  });

  test("extracts metadata before sanitizing and falls back to the URL title", async () => {
    const env = await environment("metadata");
    const request = queue(env, ALICE);
    expect((await drainOnce(deps(env, capture(PAGE))))?.state).toBe("done");
    const itemId = fetchRequest(env.db, ALICE, request.id)!.item_id!;
    expect(getItem(env.db, ALICE, itemId)).toMatchObject({
      title: "Saved title",
      author: "Ada Lovelace",
    });
    expect(await readItemFile(env.itemsRoot, ALICE, itemId, "sanitized.html")).not.toContain("<meta");

    const noTitle = "<html><body><article><p>Enough prose to become a transcript with several words.</p></article></body></html>";
    const fallbackRequest = queue(env, ALICE);
    expect((await drainOnce(deps(env, capture(noTitle))))?.state).toBe("done");
    const fallbackId = fetchRequest(env.db, ALICE, fallbackRequest.id)!.item_id!;
    expect(getItem(env.db, ALICE, fallbackId)!.title).toBe("https://example.com/article");
  });

  test("retries temporary capture failures and then exhausts the request", async () => {
    const env = await environment("retry");
    const request = queue(env, ALICE);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const outcome = await drainOnce(deps(env, captureTimeout));
      expect(outcome?.state).toBe("retry");
      expect(fetchRequest(env.db, ALICE, request.id)!.attempts).toBe(attempt);
    }
    expect(fetchRequest(env.db, ALICE, request.id)).toMatchObject({
      state: "failed", error_code: "INGEST_ATTEMPTS_EXHAUSTED",
    });
  });

  test("writes durable capture data before the item commit", async () => {
    const env = await environment("crash-safe");
    const request = queue(env, ALICE);
    const failing = async (captureRequest: CaptureRequest): Promise<CaptureResult> => {
      await Bun.write(captureRequest.outputPath, PAGE);
      throw new AppError("ACQUIRE_FAILED", "capture stopped before commit");
    };
    const outcome = await drainOnce(deps(env, failing));
    expect(outcome).toMatchObject({ state: "retry", code: "ACQUIRE_FAILED" });
    const reserved = fetchRequest(env.db, ALICE, request.id)!;
    expect(reserved.item_id).not.toBeNull();
    expect(await files(env, ALICE, reserved.item_id!)).toContain("original.html");
    expect(getItem(env.db, ALICE, reserved.item_id!)).toBeNull();
  });

  test("restarts after a child-process crash and completes the reserved request", async () => {
    const env = await environment("process-crash");
    const request = queue(env, ALICE);
    const script = join(env.itemsRoot, "..", "crash.ts");
    await Bun.write(script, `import { openDatabase } from ${JSON.stringify(join(import.meta.dir, "..", "..", "src", "store", "db"))};
import { drainOnce } from ${JSON.stringify(join(import.meta.dir, "..", "..", "src", "services", "worker"))};
const [dbPath, itemsRoot, nowIso] = process.argv.slice(2);
const at = new Date(nowIso!);
const db = openDatabase(dbPath!, at);
await drainOnce({
  db,
  itemsRoot: itemsRoot!,
  now: () => at,
  leaseMs: 1_000,
  capture: async ({ outputPath }) => {
    await Bun.write(outputPath, ${JSON.stringify(PAGE)});
    process.exit(1);
  },
});
`);
    const child = Bun.spawn(
      [process.execPath, script, env.dbPath, env.itemsRoot, env.at.toISOString()],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(1);

    const crashed = fetchRequest(env.db, ALICE, request.id)!;
    expect(crashed.state).toBe("claimed");
    expect(crashed.item_id).not.toBeNull();
    expect(await files(env, ALICE, crashed.item_id!)).toEqual([
      "original.html",
    ]);

    env.at = addMs(env.at, 2_000);
    const swept = await sweep({ ...deps(env, capture(PAGE)), orphanGraceMs: 0 });
    expect(swept.requeued).toContain(request.id);
    expect(await files(env, ALICE, crashed.item_id!)).toEqual([
      "original.html",
    ]);

    expect((await drainOnce(deps(env, capture(PAGE))))?.state).toBe("done");
    expect(fetchRequest(env.db, ALICE, request.id)!.state).toBe("done");
    expect(getItem(env.db, ALICE, crashed.item_id!)).not.toBeNull();
    expect(await files(env, ALICE, crashed.item_id!)).toEqual([
      "map.json",
      "original.html",
      "sanitized.html",
      "transcript.txt",
    ]);
  }, 20_000);

  test("sweeps expired leases before collecting reserved files", async () => {
    const env = await environment("sweep-order");
    const itemId = newItemId();
    const request = queue(env, ALICE, itemId);
    await writeItemFile(env.itemsRoot, ALICE, itemId, "original.html", "partial capture");
    claimNext(env.db, env.at, 1);
    env.at = addMs(env.at, 2);

    const result = await sweep({ ...deps(env, capture(PAGE)), orphanGraceMs: 0 });
    expect(result.requeued).toContain(request.id);
    expect(result.orphans).toEqual([]);
    expect(await files(env, ALICE, itemId)).toContain("original.html");
  });

  test("retries reuse the reserved item and leave one completed directory", async () => {
    const env = await environment("retry-id");
    const request = queue(env, ALICE);
    let attempts = 0;
    const captureOnce = async (captureRequest: CaptureRequest): Promise<CaptureResult> => {
      attempts += 1;
      if (attempts === 1) {
        await Bun.write(captureRequest.outputPath, PAGE);
        throw new AppError("ACQUIRE_FAILED", "capture stopped");
      }
      return capture(PAGE)(captureRequest);
    };
    expect((await drainOnce(deps(env, captureOnce)))?.state).toBe("retry");
    const reserved = fetchRequest(env.db, ALICE, request.id)!.item_id!;
    expect((await drainOnce(deps(env, captureOnce)))?.state).toBe("done");
    expect(fetchRequest(env.db, ALICE, request.id)!.item_id).toBe(reserved);
    expect(await readdir(join(env.itemsRoot, ALICE))).toEqual([reserved]);
  });

  test("an empty transcript is retryable and commits no item", async () => {
    const env = await environment("empty");
    const request = queue(env, ALICE);
    const outcome = await drainOnce(deps(env, capture("<html><body></body></html>")));
    expect(outcome).toMatchObject({ state: "retry", code: "INGEST_EMPTY_TRANSCRIPT" });
    expect(fetchRequest(env.db, ALICE, request.id)!.state).toBe("queued");
    expect(listItems(env.db, ALICE, 10)).toEqual([]);
  });

  test("recaptures one URL in place and allows the same URL for two tenants", async () => {
    const env = await environment("recapture");
    const first = queue(env, ALICE);
    const saved = await drainOnce(deps(env, capture(PAGE)));
    if (saved?.state !== "done") {
      throw new Error("expected the initial ingest to complete");
    }
    const itemId = saved.itemId;
    expect(fetchRequest(env.db, ALICE, first.id)!.item_id).toBe(itemId);

    const second = queue(env, ALICE);
    const changed = PAGE.replace("Saved title", "Changed title");
    expect((await drainOnce(deps(env, capture(changed))))?.state).toBe("done");
    expect(fetchRequest(env.db, ALICE, second.id)!.item_id).toBe(itemId);
    expect(listItems(env.db, ALICE, 10)).toHaveLength(1);
    expect(getItem(env.db, ALICE, itemId)!.title).toBe("Changed title");

    const bobRequest = queue(env, BOB);
    const bobSaved = await drainOnce(deps(env, capture(PAGE)));
    expect(bobSaved?.state).toBe("done");
    expect(fetchRequest(env.db, BOB, bobRequest.id)!.item_id).not.toBe(itemId);
    expect(listItems(env.db, BOB, 10)).toHaveLength(1);
    expect(searchBlocks(env.db, BOB, "durable", 10)).toHaveLength(1);
  });

  test("does not commit when the request lease is lost", async () => {
    const env = await environment("lease");
    const request = queue(env, ALICE);
    const claimed = claimNext(env.db, env.at, 1)!;
    env.at = new Date(env.at.getTime() + 2);
    sweepStaleLeases(env.db, env.at);
    claimNext(env.db, env.at, 60_000);
    const outcome = await ingestRequest(deps(env, capture(PAGE)), claimed);
    expect(outcome).toMatchObject({ state: "failed", code: "INGEST_LEASE_LOST" });
    expect(listItems(env.db, ALICE, 10)).toEqual([]);
    expect(fetchRequest(env.db, ALICE, request.id)!.state).toBe("claimed");
  });
});
