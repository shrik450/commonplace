// Acceptance test for milestone 6. It is the specification for that work.
// Change it only when the design changes, and say what changed and why.
//
// What the implementer must create
// --------------------------------
// `src/core/project.ts`, `src/core/anchor.ts`, `src/services/library.ts`,
// the routes under `src/web/routes/`, the views under `src/web/views/`, and
// `src/web/client/reader.ts`.
//
// Contract details this file pins down
// ------------------------------------
// - `project` renders content runs only. A non-content run leaves no element
//   and no text.
// - Every block element carries `data-cp-block`, `data-cp-start`, and
//   `data-cp-end`. Every run inside it carries `data-cp-path` and
//   `data-cp-start`. Those attributes are the only thing the client script
//   reads, so they are part of the contract.
// - The text a block renders is `transcript.slice(start, end)`, never the
//   sanitized document's own text. The sanitized tree decides the tag; the
//   transcript decides the characters.
// - A highlight that spans blocks emits one `mark` per block, each carrying
//   the same `data-cp-annotation`.
// - `reanchor` returns null when the quote is gone. It never guesses.
// - The reader page and the raw page need a signed-in reader. The capture
//   page needs one too, and it sends `script-src 'none'`.

import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { JSDOM } from "jsdom";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { now, toIso } from "../../src/contracts/clock";
import type { Config } from "../../src/contracts/config";
import { AppError } from "../../src/contracts/errors";
import {
  asUserId,
  newAnnotationId,
  newItemId,
} from "../../src/contracts/ids";
import type { ItemId, UserId } from "../../src/contracts/ids";
import type { User } from "../../src/contracts/item";
import { contentRanges } from "../../src/contracts/transcript";
import type { TranscriptMap } from "../../src/contracts/transcript";
import { anchorQuote, reanchor } from "../../src/core/anchor";
import { project } from "../../src/core/project";
import { sanitize } from "../../src/core/sanitize";
import { walk } from "../../src/core/walk";
import { signPayload } from "../../src/services/auth";
import {
  captureFile,
  listLibrary,
  loadTranscript,
  readerPage,
  searchLibrary,
} from "../../src/services/library";
import type { LibraryDeps } from "../../src/services/library";
import { offsetOfPoint } from "../../src/web/client/reader";
import { buildApp } from "../../src/web/server";
import { insertAnnotation } from "../../src/store/annotations";
import { openDatabase } from "../../src/store/db";
import { writeItemFile } from "../../src/store/files";
import { indexBlocks } from "../../src/store/fts";
import { insertItem, markIngested } from "../../src/store/items";
import { insertUser } from "../../src/store/users";

const ALICE = asUserId("11111111-1111-4111-8111-111111111111");
const BOB = asUserId("22222222-2222-4222-8222-222222222222");

const PAGE = `<!DOCTYPE html><html><head><title>Looms</title></head>
<body><article><h1>The Analytical Engine</h1>
<p>First paragraph with <em>emphasis</em> inside it and a little more text.</p>
<p>Second paragraph about looms and engines and analytical machines at work.</p>
<blockquote>A quoted line that the reader should see set apart from the rest.</blockquote>
<pre>  indented
  lines</pre>
<p>Closing paragraph so readability has real prose to score rather than a stub.</p>
</article><nav><a href="/x">Navigation that is not the article</a></nav></body></html>`;

// A highlight is an annotation, so its id is a branded AnnotationId. These
// stand in for rows the reader has not saved yet.
const MARK = {
  one: newAnnotationId(),
  r: newAnnotationId(),
  wide: newAnnotationId(),
  all: newAnnotationId(),
  none: newAnnotationId(),
  a: newAnnotationId(),
  b: newAnnotationId(),
};

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

function makeUser(id: UserId, subject: string): User {
  return {
    id,
    subject,
    email: `${subject}@example.com`,
    created_at: toIso(new Date("2026-01-01T00:00:00.000Z")),
  };
}

const CONFIG: Config = {
  db_root: "/unused",
  items_root: "/unused",
  issuer_url: "https://id.example.com",
  client_id: "commonplace",
  client_secret: "secret",
  session_secret: "a-session-secret-long-enough-to-sign-with",
};

function sessionCookie(userId: UserId, at: Date): string {
  const value = signPayload(CONFIG.session_secret, {
    user_id: userId,
    iat: toIso(at),
    exp: toIso(new Date(at.getTime() + 60_000)),
  });
  return `cp_session=${value}`;
}

type Env = {
  db: Database;
  itemsRoot: string;
  deps: LibraryDeps;
  itemId: ItemId;
  transcript: string;
  map: TranscriptMap;
  sanitized: string;
};

async function freshEnv(name: string, owner: UserId = ALICE): Promise<Env> {
  const root = await mkdtemp(join(tmpdir(), `commonplace-reader-${name}-`));
  roots.push(root);
  const at = now();
  const db = openDatabase(join(root, "commonplace.db"), at);
  insertUser(db, makeUser(ALICE, "alice"));
  insertUser(db, makeUser(BOB, "bob"));

  const itemsRoot = join(root, "items");
  const itemId = newItemId();
  const sanitized = sanitize(PAGE);
  const { text, map } = walk(sanitized);

  await writeItemFile(itemsRoot, owner, itemId, "original.html", PAGE);
  await writeItemFile(itemsRoot, owner, itemId, "sanitized.html", sanitized);
  await writeItemFile(itemsRoot, owner, itemId, "transcript.txt", text);
  await writeItemFile(itemsRoot, owner, itemId, "map.json", JSON.stringify(map));

  insertItem(db, {
    id: itemId,
    user_id: owner,
    kind: "article",
    url: "https://example.com/looms",
    title: "The Analytical Engine",
    author: "Ada Lovelace",
    created_at: toIso(at),
    ingested_at: null,
  });
  markIngested(db, owner, itemId, at);

  const blocks = new Map<
    number,
    { start: number; end: number; is_content: boolean }
  >();
  for (const run of map.runs) {
    const found = blocks.get(run.block_index);
    if (found) found.end = run.end;
    else
      blocks.set(run.block_index, {
        start: run.start,
        end: run.end,
        is_content: run.is_content,
      });
  }
  indexBlocks(
    db,
    itemId,
    [...blocks].map(([block_index, block]) => ({
      item_id: itemId,
      user_id: owner,
      block_index,
      start_offset: block.start,
      end_offset: block.end,
      is_content: block.is_content,
      text: text.slice(block.start, block.end),
    })),
  );

  return {
    db,
    itemsRoot,
    deps: { db, itemsRoot },
    itemId,
    transcript: text,
    map,
    sanitized,
  };
}

function parse(html: string): Document {
  return new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`).window
    .document;
}

function highlightedText(html: string, id: string): string {
  const doc = parse(html);
  return [...doc.querySelectorAll(`mark[data-cp-annotation="${id}"]`)]
    .map((mark) => mark.textContent ?? "")
    .join("");
}

function expectedText(
  map: TranscriptMap,
  transcript: string,
  start: number,
  end: number,
): string {
  return contentRanges(map, start, end)
    .map((range) => transcript.slice(range.start, range.end))
    .join("");
}

describe("src/core/project renders the transcript, not the document", () => {
  test("every block carries its transcript range", async () => {
    const env = await freshEnv("blocks");
    const doc = parse(project({ ...env, sanitizedHtml: env.sanitized }));

    const blocks = [...doc.querySelectorAll("[data-cp-block]")];
    expect(blocks.length).toBeGreaterThan(0);

    for (const block of blocks) {
      const start = Number(block.getAttribute("data-cp-start"));
      const end = Number(block.getAttribute("data-cp-end"));
      expect(block.textContent).toBe(env.transcript.slice(start, end));
    }
  });

  test("block indices rise in document order and never repeat", async () => {
    const env = await freshEnv("order");
    const doc = parse(project({ ...env, sanitizedHtml: env.sanitized }));

    const indices = [...doc.querySelectorAll("[data-cp-block]")].map((block) =>
      Number(block.getAttribute("data-cp-block")),
    );
    expect(indices).toEqual([...indices].toSorted((a, b) => a - b));
    expect(new Set(indices).size).toBe(indices.length);
  });

  test("every run inside a block carries its path and its start", async () => {
    const env = await freshEnv("runs");
    const doc = parse(project({ ...env, sanitizedHtml: env.sanitized }));

    const spans = [...doc.querySelectorAll("[data-cp-path]")];
    expect(spans.length).toBeGreaterThan(0);

    for (const span of spans) {
      const start = Number(span.getAttribute("data-cp-start"));
      const text = span.textContent ?? "";
      expect(text).toBe(env.transcript.slice(start, start + text.length));
    }
  });

  test("the sanitized tree decides the tag", async () => {
    const env = await freshEnv("tags");
    const doc = parse(project({ ...env, sanitizedHtml: env.sanitized }));

    expect(doc.querySelector("h1")?.textContent?.trim()).toBe(
      "The Analytical Engine",
    );
    expect(doc.querySelector("blockquote")).not.toBeNull();
    const pre = doc.querySelector("pre");
    expect(pre?.textContent).toContain("  indented");
  });

  // The separator run before a block carries the *previous* block's index, so
  // a block's own range ends with the newline that follows it. Dropping that
  // character would render a block the round trip could not reproduce.
  test("a block ends with the separator that follows it", async () => {
    const env = await freshEnv("separator");
    const doc = parse(project({ ...env, sanitizedHtml: env.sanitized }));

    const heading = doc.querySelector("h1")!;
    expect(heading.textContent).toBe("The Analytical Engine\n");
  });

  test("a non-content run leaves no element and no text", async () => {
    const env = await freshEnv("content-only");
    const html = project({ ...env, sanitizedHtml: env.sanitized });

    expect(html).not.toContain("Navigation that is not the article");

    const doc = parse(html);
    const rendered = [...doc.querySelectorAll("[data-cp-block]")].map((block) =>
      Number(block.getAttribute("data-cp-block")),
    );
    const contentBlocks = new Set(
      env.map.runs.filter((run) => run.is_content).map((run) => run.block_index),
    );
    for (const index of rendered) expect(contentBlocks.has(index)).toBe(true);
  });

  test("text is escaped, so a hostile transcript cannot inject markup", () => {
    const transcript = `<script>alert(1)</script>`;
    const map: TranscriptMap = {
      runs: [
        {
          start: 0,
          end: transcript.length,
          doc_index: 0,
          node_path: "1/0/0",
          block_index: 0,
          is_content: true,
        },
      ],
    };
    const html = project({
      sanitizedHtml: sanitize("<html><body><p>placeholder</p></body></html>"),
      transcript,
      map,
    });

    expect(html).not.toContain("<script");
    expect(parse(html).body.textContent).toBe(transcript);
  });
});

describe("the round trip", () => {
  test("a whole-block highlight reads back exactly", async () => {
    const env = await freshEnv("round-block");
    const first = env.map.runs.find((run) => run.is_content)!;
    const html = project({
      ...env,
      sanitizedHtml: env.sanitized,
      highlights: [{ id: MARK.one, start: first.start, end: first.end }],
    });

    expect(highlightedText(html, MARK.one)).toBe(
      env.transcript.slice(first.start, first.end),
    );
  });

  test("every content range reads back exactly", async () => {
    const env = await freshEnv("round-every");
    const content = env.map.runs.filter((run) => run.is_content);

    for (const run of content) {
      for (const [start, end] of [
        [run.start, run.end],
        [run.start, run.start + 1],
        [run.start + 1, run.end],
        [Math.floor((run.start + run.end) / 2), run.end],
      ] as const) {
        if (end <= start) continue;
        const html = project({
          ...env,
          sanitizedHtml: env.sanitized,
          highlights: [{ id: MARK.r, start, end }],
        });
        expect(highlightedText(html, MARK.r)).toBe(
          expectedText(env.map, env.transcript, start, end),
        );
      }
    }
  });

  test("a highlight across blocks emits one mark per block", async () => {
    const env = await freshEnv("round-span");
    const content = env.map.runs.filter((run) => run.is_content);
    const start = content[0]!.start;
    const end = content[content.length - 1]!.end;

    const html = project({
      ...env,
      sanitizedHtml: env.sanitized,
      highlights: [{ id: MARK.wide, start, end }],
    });

    const doc = parse(html);
    const marks = doc.querySelectorAll(`mark[data-cp-annotation="${MARK.wide}"]`);
    expect(marks.length).toBeGreaterThan(1);
    expect(highlightedText(html, MARK.wide)).toBe(
      expectedText(env.map, env.transcript, start, end),
    );
  });

  test("a range that crosses non-content renders the content parts in order", async () => {
    const env = await freshEnv("round-mixed");
    const html = project({
      ...env,
      sanitizedHtml: env.sanitized,
      highlights: [{ id: MARK.all, start: 0, end: env.transcript.length }],
    });

    expect(highlightedText(html, MARK.all)).toBe(
      expectedText(env.map, env.transcript, 0, env.transcript.length),
    );
  });

  test("an empty or reversed range highlights nothing", async () => {
    const env = await freshEnv("round-empty");
    for (const [start, end] of [
      [10, 10],
      [20, 5],
    ] as const) {
      const html = project({
        ...env,
        sanitizedHtml: env.sanitized,
        highlights: [{ id: MARK.none, start, end }],
      });
      expect(html).not.toContain("data-cp-annotation");
    }
  });

  test("two highlights in one block both survive", async () => {
    const env = await freshEnv("round-two");
    const run = env.map.runs.find(
      (candidate) => candidate.is_content && candidate.end - candidate.start > 20,
    )!;
    const html = project({
      ...env,
      sanitizedHtml: env.sanitized,
      highlights: [
        { id: MARK.a, start: run.start, end: run.start + 5 },
        { id: MARK.b, start: run.start + 10, end: run.start + 15 },
      ],
    });

    expect(highlightedText(html, MARK.a)).toBe(
      env.transcript.slice(run.start, run.start + 5),
    );
    expect(highlightedText(html, MARK.b)).toBe(
      env.transcript.slice(run.start + 10, run.start + 15),
    );
  });
});

describe("src/core/anchor", () => {
  const text = "The loom weaves. The engine counts. The loom weaves again.";

  test("an offset that still matches its quote does not move", () => {
    const result = reanchor(text, { start: 4, end: 8, quote: "loom" });
    expect(result).toEqual({ start: 4, end: 8, moved: false });
  });

  test("a shifted offset moves to the nearest match", () => {
    const result = reanchor(text, { start: 6, end: 10, quote: "loom" });
    expect(result).toEqual({ start: 4, end: 8, moved: true });
  });

  test("the nearest match wins when the quote repeats", () => {
    const result = reanchor(text, { start: 44, end: 48, quote: "loom" });
    expect(result).toEqual({ start: 40, end: 44, moved: true });
  });

  test("a quote that is gone returns null", () => {
    expect(reanchor(text, { start: 0, end: 6, quote: "spindle" })).toBeNull();
  });

  test("an empty quote returns null rather than an empty range", () => {
    expect(reanchor(text, { start: 0, end: 0, quote: "" })).toBeNull();
  });

  test("anchorQuote places a highlight that arrives with no offsets", () => {
    expect(anchorQuote(text, "engine counts")).toEqual({
      start: 21,
      end: 34,
      moved: true,
    });
  });

  test("anchorQuote prefers the match nearest the hint", () => {
    expect(anchorQuote(text, "loom", 50)).toEqual({
      start: 40,
      end: 44,
      moved: true,
    });
  });

  test("anchorQuote returns null for a quote the transcript does not hold", () => {
    expect(anchorQuote(text, "spindle")).toBeNull();
  });
});

describe("src/services/library", () => {
  test("loadTranscript returns the item, its text, and its map", async () => {
    const env = await freshEnv("load");
    const loaded = await loadTranscript(env.deps, ALICE, env.itemId);

    expect(loaded.item.title).toBe("The Analytical Engine");
    expect(loaded.transcript).toBe(env.transcript);
    expect(loaded.map.runs).toEqual(env.map.runs);
  });

  test("another tenant cannot load the item", async () => {
    const env = await freshEnv("load-tenant");
    const failure = await loadTranscript(env.deps, BOB, env.itemId).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).code).toBe("STORE_NOT_FOUND");
  });

  test("readerPage projects the item's stored annotations", async () => {
    const env = await freshEnv("reader-page");
    const run = env.map.runs.find((candidate) => candidate.is_content)!;
    const id = newAnnotationId();
    insertAnnotation(env.db, {
      id,
      user_id: ALICE,
      item_id: env.itemId,
      start_offset: run.start,
      end_offset: run.end,
      quote: env.transcript.slice(run.start, run.end),
      note: "a note",
      created_at: toIso(now()),
      updated_at: toIso(now()),
    });

    const page = await readerPage(env.deps, ALICE, env.itemId);
    expect(page.annotations).toHaveLength(1);
    expect(highlightedText(page.html, id)).toBe(
      env.transcript.slice(run.start, run.end),
    );
  });

  test("readerPage re-anchors an annotation whose offsets drifted", async () => {
    const env = await freshEnv("reader-drift");
    const run = env.map.runs.find(
      (candidate) => candidate.is_content && candidate.end - candidate.start > 20,
    )!;
    const quote = env.transcript.slice(run.start + 2, run.start + 12);
    const id = newAnnotationId();
    insertAnnotation(env.db, {
      id,
      user_id: ALICE,
      item_id: env.itemId,
      start_offset: run.start + 3,
      end_offset: run.start + 13,
      quote,
      note: null,
      created_at: toIso(now()),
      updated_at: toIso(now()),
    });

    const page = await readerPage(env.deps, ALICE, env.itemId);
    expect(highlightedText(page.html, id)).toBe(quote);
  });

  test("listLibrary lists only the reader's own items", async () => {
    const env = await freshEnv("list");
    expect(listLibrary(env.deps, ALICE, 10)).toHaveLength(1);
    expect(listLibrary(env.deps, BOB, 10)).toEqual([]);
  });

  test("searchLibrary returns the item, the range, and a split snippet", async () => {
    const env = await freshEnv("search");
    const hits = searchLibrary(env.deps, ALICE, "looms", 10);

    expect(hits.length).toBeGreaterThan(0);
    const hit = hits[0]!;
    expect(hit.item.id).toBe(env.itemId);
    expect(env.transcript.slice(hit.start_offset, hit.end_offset)).toContain(
      "looms",
    );
    expect(hit.snippet.some((part) => part.hit)).toBe(true);
    for (const part of hit.snippet) {
      expect(part.text).not.toContain("\u0002");
      expect(part.text).not.toContain("\u0003");
    }
  });

  test("searchLibrary finds nothing for another tenant", async () => {
    const env = await freshEnv("search-tenant");
    expect(searchLibrary(env.deps, BOB, "looms", 10)).toEqual([]);
  });

  test("captureFile returns the sanitized file unchanged", async () => {
    const env = await freshEnv("capture");
    expect(await captureFile(env.deps, ALICE, env.itemId)).toBe(env.sanitized);
  });
});

describe("the web routes", () => {
  async function serve(name: string): Promise<{ env: Env; app: ReturnType<typeof buildApp> }> {
    const env = await freshEnv(name);
    const app = buildApp({
      db: env.db,
      config: { ...CONFIG, items_root: env.itemsRoot },
      now,
    });
    return { env, app };
  }

  function get(
    app: ReturnType<typeof buildApp>,
    path: string,
    cookie?: string,
  ): Promise<Response> {
    return app.handle(
      new Request(`http://localhost${path}`, {
        headers: cookie ? { cookie } : {},
      }),
    );
  }

  test("the library page lists the reader's items", async () => {
    const { env, app } = await serve("route-library");
    const response = await get(app, "/library", sessionCookie(ALICE, now()));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("The Analytical Engine");
    expect(env.itemId).toBeDefined();
  });

  test("a signed-out reader is sent to the login route", async () => {
    const { app } = await serve("route-signed-out");
    const response = await get(app, "/library");

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login");
  });

  test("the reader page carries the projection and the client script", async () => {
    const { env, app } = await serve("route-reader");
    const response = await get(
      app,
      `/items/${env.itemId}`,
      sessionCookie(ALICE, now()),
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("data-cp-block");
    expect(body).toContain("The Analytical Engine");
    expect(body).toContain("/reader.js");
  });

  test("another tenant's item is not found", async () => {
    const { env, app } = await serve("route-tenant");
    const response = await get(
      app,
      `/items/${env.itemId}`,
      sessionCookie(BOB, now()),
    );

    expect(response.status).toBe(404);
  });

  test("an item id that is not a UUID is a bad request", async () => {
    const { app } = await serve("route-badid");
    const response = await get(app, "/items/nope", sessionCookie(ALICE, now()));

    expect(response.status).toBe(400);
  });

  test("the raw page serves the transcript as plain text", async () => {
    const { env, app } = await serve("route-raw");
    const response = await get(
      app,
      `/items/${env.itemId}/raw`,
      sessionCookie(ALICE, now()),
    );

    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe(env.transcript);
  });

  test("the capture page serves the sanitized file with no script allowed", async () => {
    const { env, app } = await serve("route-capture");
    const response = await get(
      app,
      `/items/${env.itemId}/capture`,
      sessionCookie(ALICE, now()),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain(
      "script-src 'none'",
    );
    expect(await response.text()).not.toContain("<script");
  });

  test("the search page shows a hit and links into the item", async () => {
    const { env, app } = await serve("route-search");
    const response = await get(
      app,
      "/search?q=looms",
      sessionCookie(ALICE, now()),
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain(`/items/${env.itemId}`);
  });

  test("the search page with no query asks for one instead of failing", async () => {
    const { app } = await serve("route-search-empty");
    const response = await get(app, "/search", sessionCookie(ALICE, now()));

    expect(response.status).toBe(200);
  });

  test("the client script is served as JavaScript", async () => {
    const { app } = await serve("route-script");
    const response = await get(app, "/reader.js");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
  });
});

describe("src/web/client/reader offsets", () => {
  test("a point inside a run resolves to a transcript offset", () => {
    const doc = parse(
      `<p data-cp-block="0" data-cp-start="0" data-cp-end="11">` +
        `<span data-cp-path="1/0/0" data-cp-start="0">hello </span>` +
        `<span data-cp-path="1/0/1" data-cp-start="6">world</span></p>`,
    );
    const second = doc.querySelectorAll("[data-cp-path]")[1]!;

    expect(offsetOfPoint(second.firstChild!, 3)).toBe(9);
  });

  test("a point outside any run resolves to null", () => {
    const doc = parse(`<p>loose text</p>`);
    expect(offsetOfPoint(doc.querySelector("p")!.firstChild!, 2)).toBeNull();
  });
});
