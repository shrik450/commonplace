import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { JSDOM } from "jsdom";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addMs, now, toIso } from "../../src/contracts/clock";
import type { Config } from "../../src/contracts/config";
import { asUserId, newAnnotationId, newItemId } from "../../src/contracts/ids";
import type { ItemId, UserId } from "../../src/contracts/ids";
import type { Annotation, Item, User } from "../../src/contracts/item";
import { anchorQuote, reanchor } from "../../src/core/anchor";
import { project } from "../../src/core/project";
import { sanitize } from "../../src/core/sanitize";
import { walk } from "../../src/core/walk";
import { createApiToken, signPayload } from "../../src/services/auth";
import { captureFile, readerPage, searchLibrary } from "../../src/services/library";
import { buildApp } from "../../src/web/server";
import { insertAnnotation } from "../../src/store/annotations";
import { openDatabase } from "../../src/store/db";
import { writeItemFile } from "../../src/store/files";
import { indexBlocks } from "../../src/store/fts";
import { insertItem } from "../../src/store/items";
import { insertUser } from "../../src/store/users";

const ALICE = asUserId("11111111-1111-4111-8111-111111111111");
const BOB = asUserId("22222222-2222-4222-8222-222222222222");
const PAGE = "<html><head><title>Reader</title></head><body><article><h1>Reader title</h1><p>First paragraph with enough content to score as an article.</p><p>Second paragraph for highlights and search.</p></article><nav>Hidden navigation</nav></body></html>";
const CONFIG: Config = {
  db_root: "/unused",
  items_root: "/unused",
  base_url: "https://reader.example.com",
  issuer_url: "https://issuer.example.com",
  client_id: "client",
  client_secret: "secret",
  session_secret: "x".repeat(32),
  browser_path: "/usr/bin/chromium",
};
const roots: string[] = [];

type Env = {
  db: Database;
  itemsRoot: string;
  itemId: ItemId;
  transcript: string;
  map: ReturnType<typeof walk>["map"];
  sanitized: string;
};

function user(id: UserId, subject: string): User {
  return { id, subject, email: null, created_at: "2026-01-01T00:00:00.000Z" };
}

async function environment(name: string, owner: UserId = ALICE): Promise<Env> {
  const root = await mkdtemp(join(tmpdir(), `commonplace-reader-${name}-`));
  roots.push(root);
  const db = openDatabase(join(root, "db.sqlite"), now());
  insertUser(db, user(ALICE, "alice"));
  insertUser(db, user(BOB, "bob"));
  const itemsRoot = join(root, "items");
  const itemId = newItemId();
  const sanitized = sanitize(PAGE);
  const { text: transcript, map } = walk(sanitized);
  await writeItemFile(itemsRoot, owner, itemId, "sanitized.html", sanitized);
  await writeItemFile(itemsRoot, owner, itemId, "transcript.txt", transcript);
  await writeItemFile(itemsRoot, owner, itemId, "map.json", JSON.stringify(map));
  const item: Item = {
    id: itemId,
    user_id: owner,
    url: "https://example.com/reader",
    title: "Reader title",
    author: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ingested_at: "2026-01-01T00:00:00.000Z",
  };
  insertItem(db, item);
  const blocks = new Map<number, { start: number; end: number; is_content: boolean }>();
  for (const run of map.runs) {
    const block = blocks.get(run.block_index);
    if (block) block.end = run.end;
    else blocks.set(run.block_index, { start: run.start, end: run.end, is_content: run.is_content });
  }
  indexBlocks(db, itemId, [...blocks].map(([block_index, block]) => ({
    item_id: itemId,
    user_id: owner,
    block_index,
    start_offset: block.start,
    end_offset: block.end,
    is_content: block.is_content,
    text: transcript.slice(block.start, block.end),
  })));
  return { db, itemsRoot, itemId, transcript, map, sanitized };
}

function cookie(userId: UserId): string {
  return `cp_session=${signPayload(CONFIG.session_secret, {
    user_id: userId,
    exp: addMs(now(), 60_000).toISOString(),
  })}`;
}

function highlighted(html: string, id: string): string {
  const document = new JSDOM(`<body>${html}</body>`).window.document;
  return [...document.querySelectorAll(`mark[data-cp-annotation="${id}"]`)]
    .map((mark) => mark.textContent ?? "")
    .join("");
}

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

describe("reader projection", () => {
  test("renders content from the transcript and hides non-content text", async () => {
    const env = await environment("projection");
    const run = env.map.runs.find((candidate) => candidate.is_content)!;
    const id = newAnnotationId();
    const html = project({
      sanitizedHtml: env.sanitized,
      transcript: env.transcript,
      map: env.map,
      highlights: [{ id, start: run.start, end: run.end }],
    });
    expect(html).toContain("Reader title");
    expect(html).not.toContain("Hidden navigation");
    expect(highlighted(html, String(id))).toContain("Reader title");
  });

  test("a highlight crossing content runs reads back the projected content", async () => {
    const env = await environment("round-trip");
    const content = env.map.runs.filter((run) => run.is_content);
    const start = content[0]!.start;
    const end = content.at(-1)!.end;
    const id = newAnnotationId();
    const html = project({ sanitizedHtml: env.sanitized, transcript: env.transcript, map: env.map, highlights: [{ id, start, end }] });
    const expected = env.transcript.slice(0, env.transcript.indexOf("Hidden navigation"));
    expect(new JSDOM(`<body>${html}</body>`).window.document.querySelectorAll(`mark[data-cp-annotation="${id}"]`).length).toBeGreaterThan(1);
    expect(highlighted(html, String(id))).toBe(expected);
    expect(highlighted(html, String(id))).not.toContain("Hidden navigation");
  });

  test("projects partial ranges at run boundaries without changing their text", async () => {
    const env = await environment("projection-boundaries");
    const run = env.map.runs.find((candidate) => candidate.is_content && candidate.end - candidate.start > 8)!;
    const cases = [
      [run.start, run.start + 3],
      [run.start + 1, run.end],
      [run.start, run.end],
    ] as const;
    for (const [start, end] of cases) {
      const id = newAnnotationId();
      const html = project({ sanitizedHtml: env.sanitized, transcript: env.transcript, map: env.map, highlights: [{ id, start, end }] });
      expect(highlighted(html, String(id))).toBe(env.transcript.slice(start, end));
    }
  });

  test("keeps multiple marks and ignores empty or reversed ranges", async () => {
    const env = await environment("projection-multiple");
    const run = env.map.runs.find((candidate) => candidate.is_content && candidate.end - candidate.start > 20)!;
    const first = newAnnotationId();
    const second = newAnnotationId();
    const empty = newAnnotationId();
    const reversed = newAnnotationId();
    const html = project({ sanitizedHtml: env.sanitized, transcript: env.transcript, map: env.map, highlights: [
      { id: first, start: run.start, end: run.start + 5 },
      { id: second, start: run.start + 10, end: run.start + 15 },
      { id: empty, start: 4, end: 4 },
      { id: reversed, start: 8, end: 2 },
    ] });
    expect(highlighted(html, String(first))).toBe(env.transcript.slice(run.start, run.start + 5));
    expect(highlighted(html, String(second))).toBe(env.transcript.slice(run.start + 10, run.start + 15));
    const document = new JSDOM(`<body>${html}</body>`).window.document;
    expect(document.querySelectorAll(`mark[data-cp-annotation="${empty}"]`)).toHaveLength(0);
    expect(document.querySelectorAll(`mark[data-cp-annotation="${reversed}"]`)).toHaveLength(0);
  });

  test("readerPage places stored annotations by quote", async () => {
    const env = await environment("annotations");
    const run = env.map.runs.find((candidate) => candidate.is_content && candidate.end - candidate.start > 10)!;
    const quote = env.transcript.slice(run.start + 1, run.start + 8);
    const id = newAnnotationId();
    insertAnnotation(env.db, {
      id,
      user_id: ALICE,
      item_id: env.itemId,
      start_offset: run.start,
      end_offset: run.start + quote.length,
      quote,
      note: null,
      created_at: toIso(now()),
      updated_at: toIso(now()),
    });
    const page = await readerPage({ db: env.db, itemsRoot: env.itemsRoot }, ALICE, env.itemId);
    expect(highlighted(page.html, String(id))).toBe(quote);
  });
});

describe("anchor behavior", () => {
  test("keeps valid offsets, moves stale quotes, and hides missing quotes", () => {
    const text = "The loom weaves. The engine counts. The loom weaves again.";
    expect(reanchor(text, { start: 4, end: 8, quote: "loom" })).toMatchObject({ moved: false });
    expect(anchorQuote(text, "engine counts")).toMatchObject({ start: 21, end: 34 });
    expect(reanchor(text, { start: 0, end: 4, quote: "gone" })).toBeNull();
  });
});

describe("authenticated reader routes", () => {
  test("an authenticated reader can open the library and reader page", async () => {
    const env = await environment("authenticated-success");
    const app = buildApp({ db: env.db, config: { ...CONFIG, items_root: env.itemsRoot }, now });
    const library = await app.handle(new Request("http://localhost/library", { headers: { cookie: cookie(ALICE) } }));
    expect(library.status).toBe(200);
    expect(await library.text()).toContain("Reader title");

    const reader = await app.handle(new Request(`http://localhost/items/${env.itemId}`, { headers: { cookie: cookie(ALICE) } }));
    expect(reader.status).toBe(200);
    expect(await reader.text()).toContain("data-cp-block");
  });

  test("rejects an invalid item ID at the route boundary", async () => {
    const env = await environment("invalid-item-id");
    const app = buildApp({ db: env.db, config: { ...CONFIG, items_root: env.itemsRoot }, now });
    const response = await app.handle(new Request("http://localhost/items/not-an-item-id", { headers: { cookie: cookie(ALICE) } }));
    expect(response.status).toBe(400);
  });

  test("serve the raw transcript and CSP-protected capture only to the owner", async () => {
    const env = await environment("routes");
    const app = buildApp({ db: env.db, config: { ...CONFIG, items_root: env.itemsRoot }, now });
    const raw = await app.handle(new Request(`http://localhost/items/${env.itemId}/raw`, { headers: { cookie: cookie(ALICE) } }));
    expect(raw.status).toBe(200);
    expect(await raw.text()).toBe(env.transcript);
    const capture = await app.handle(new Request(`http://localhost/items/${env.itemId}/capture`, { headers: { cookie: cookie(ALICE) } }));
    expect(capture.headers.get("content-security-policy")).toContain("script-src 'none'");
    const other = await app.handle(new Request(`http://localhost/items/${env.itemId}`, { headers: { cookie: cookie(BOB) } }));
    expect(other.status).toBe(404);
    const signedOut = await app.handle(new Request(`http://localhost/items/${env.itemId}`));
    expect(signedOut.status).toBe(303);
  });

  test("every protected GET redirects signed-out readers", async () => {
    const env = await environment("route-guards");
    const app = buildApp({ db: env.db, config: { ...CONFIG, items_root: env.itemsRoot }, now });
    const { token } = createApiToken(env.db, ALICE, "reader", now());
    const paths = [
      "/library",
      "/search?q=reader",
      "/settings",
      `/settings/tokens/${token.id}/revoke`,
      `/items/${env.itemId}`,
      `/items/${env.itemId}/raw`,
      `/items/${env.itemId}/capture`,
    ];
    for (const path of paths) {
      const response = await app.handle(new Request(`http://localhost${path}`));
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/login");
    }
  });

  test("every item representation keeps the tenant boundary", async () => {
    const env = await environment("route-tenant-all");
    const app = buildApp({ db: env.db, config: { ...CONFIG, items_root: env.itemsRoot }, now });
    for (const suffix of ["", "/raw", "/capture"]) {
      const response = await app.handle(new Request(`http://localhost/items/${env.itemId}${suffix}`, { headers: { cookie: cookie(BOB) } }));
      expect(response.status).toBe(404);
    }
  });

  test("search returns transcript-aligned ranges and links to the block", async () => {
    const env = await environment("search-route");
    const end = env.transcript.indexOf("\n");
    const text = env.transcript.slice(0, end);
    indexBlocks(env.db, env.itemId, [{
      item_id: env.itemId,
      user_id: ALICE,
      block_index: 0,
      start_offset: 0,
      end_offset: end,
      is_content: true,
      text,
    }]);
    const library = { db: env.db, itemsRoot: env.itemsRoot };
    expect(searchLibrary(library, ALICE, " ", 10)).toEqual([]);
    const hits = searchLibrary(library, ALICE, "Reader", 10);
    expect(hits).toHaveLength(1);
    const hit = hits[0]!;
    expect(env.transcript.slice(hit.start_offset, hit.end_offset)).toBe(text);
    expect(env.transcript.slice(hit.start_offset, hit.end_offset)).toContain("Reader");
    expect(hit.snippet.some((part) => part.hit)).toBe(true);

    const app = buildApp({ db: env.db, config: { ...CONFIG, items_root: env.itemsRoot }, now });
    const response = await app.handle(new Request("http://localhost/search?q=Reader", { headers: { cookie: cookie(ALICE) } }));
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain(`/items/${env.itemId}#b0`);
  });

  test("captureFile returns the sanitized durable file", async () => {
    const env = await environment("capture-file");
    expect(await captureFile({ db: env.db, itemsRoot: env.itemsRoot }, ALICE, env.itemId)).toBe(env.sanitized);
  });
});
