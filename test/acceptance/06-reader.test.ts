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
import { blocksOf } from "../../src/contracts/transcript";
import type { Item, User } from "../../src/contracts/item";
import { anchorQuote, reanchor } from "../../src/core/anchor";
import { project } from "../../src/core/project";
import { sanitize } from "../../src/core/sanitize";
import { walk } from "../../src/core/walk";
import { createApiToken, signPayload } from "../../src/services/auth";
import { captureFile, readerPage, searchLibrary } from "../../src/services/library";
import { buildApp } from "../../src/web/server";
import { openDatabase } from "../../src/store/db";
import { writeItemFile } from "../../src/store/files";
import { indexBlocks } from "../../src/store/fts";
import { insertItem } from "../../src/store/items";
import { insertUser } from "../../src/store/users";

const ALICE = asUserId("11111111-1111-4111-8111-111111111111");
const BOB = asUserId("22222222-2222-4222-8222-222222222222");
const PAGE = "<html><head><title>Reader</title></head><body><article><h1>Reader title</h1><p>First paragraph with enough content to score as an article.</p><p>Second paragraph for highlights and search.</p></article><nav>Hidden navigation</nav></body></html>";
const ORIGINAL_PAGE = PAGE.replace(
  "<head>",
  "<head><style>@font-face { font-family: saved; src: url(data:font/woff2;base64,AAAA); } body { color: red; }</style><script>window hostile = true;</script>",
).replace(
  "</body>",
  '<img src="data:image/png;base64,AAAA" alt="Saved diagram" /></body>',
);
const STRUCTURED_PAGE = `<html><head><title>Structured</title><style>.remote { background: url(https://cdn.example/remote.png); }</style></head><body>
  <article>
    <h1>Structured content</h1>
    <p>A long article paragraph gives the reader enough content to preserve every structure below. <a href="https://example.com/destination">A discoverable link</a> uses <em>emphasis</em>, <strong>strong text</strong>, <s>struck text</s>, and <code>inline()</code>.</p>
    <blockquote><p>A quoted passage remains a block quote.</p></blockquote>
    <ol><li>First ordered item</li><li>Second ordered item</li></ol>
    <ul><li>Unordered item with <img src="https://cdn.example/remote.png" alt="Remote diagram" /></li><li>Embedded <img src="data:image/png;base64,AAAA" alt="Embedded diagram" /></li></ul>
    <pre><code>const value = 1;</code></pre>
    <figure><img src="data:image/png;base64,BBBB" alt="Standalone diagram" /></figure>
    <table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>One</td><td>Two</td></tr></tbody></table>
    <hr />
    <script>document.body.innerHTML = "hostile";</script><iframe src="https://evil.example/frame"></iframe>
  </article>
</body></html>`;
const WRAPPER_PAGE = `<html><body><article>
  <address>Address text</address><dl><dt>Term</dt><dd>Definition</dd></dl>
  <fieldset><summary>Summary</summary><p>Field text</p></fieldset>
  <footer>Footer text</footer><header>Header text</header><hgroup><h2>Group text</h2></hgroup>
  <main>Main text</main><nav>Navigation text</nav><noscript>Noscript text</noscript>
</article></body></html>`;
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
  original: string;
};

function user(id: UserId, subject: string): User {
  return { id, subject, email: null, created_at: "2026-01-01T00:00:00.000Z" };
}

async function environment(
  name: string,
  owner: UserId = ALICE,
  original: string = ORIGINAL_PAGE,
): Promise<Env> {
  const root = await mkdtemp(join(tmpdir(), `commonplace-reader-${name}-`));
  roots.push(root);
  const db = openDatabase(join(root, "db.sqlite"), now());
  insertUser(db, user(ALICE, "alice"));
  insertUser(db, user(BOB, "bob"));
  const itemsRoot = join(root, "items");
  const itemId = newItemId();
  const sanitized = sanitize(original);
  const { text: transcript, map } = walk(sanitized);
  await writeItemFile(itemsRoot, owner, itemId, "original.html", original);
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
  return { db, itemsRoot, itemId, transcript, map, sanitized, original };
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

  test("keeps every allowed wrapper in the structured projection", async () => {
    const env = await environment("structured-wrappers", ALICE, WRAPPER_PAGE);
    const document = new JSDOM(project({
      sanitizedHtml: env.sanitized,
      transcript: env.transcript,
      map: env.map,
      mode: "structured",
    })).window.document;
    for (const tag of [
      "address", "dd", "dl", "dt", "fieldset", "footer", "header",
      "hgroup", "main", "nav", "summary", "noscript",
    ]) {
      expect(document.querySelector(`.cp-transcript ${tag}`)).not.toBeNull();
    }
    expect(document.querySelector("address")?.textContent).toContain("Address text");
    expect(document.querySelector("dd")?.textContent).toContain("Definition");
    expect(document.querySelector("noscript")?.textContent).toContain("Noscript text");
  });

  test("keeps multiple blocks owned by one element addressable", async () => {
    const sanitized = sanitize("<html><body><article>before <p>nested</p> after</article></body></html>");
    const walked = walk(sanitized);
    const html = project({
      sanitizedHtml: sanitized,
      transcript: walked.text,
      map: walked.map,
      mode: "structured",
    });
    const document = new JSDOM(html).window.document;
    const blocks = blocksOf(walked.map);
    expect(blocks).toHaveLength(3);
    expect(document.querySelectorAll('[id^="b"]')).toHaveLength(3);
    for (const block of blocks) {
      const target = document.querySelector(`#b${block.index}`);
      expect(target?.textContent).toContain(walked.text.slice(block.runs[0]!.start, block.runs[0]!.end));
      expect(target?.getAttribute("data-cp-start")).toBe(String(block.runs[0]!.start));
      expect(target?.getAttribute("data-cp-end")).toBe(String(block.runs.at(-1)!.end));
    }
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
    env.db.run(
      "INSERT INTO annotations (id, user_id, item_id, start_offset, end_offset, quote, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)",
      [id, ALICE, env.itemId, run.start, run.start + quote.length, quote, toIso(now()), toIso(now())],
    );
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
    const readerBody = await reader.text();
    expect(readerBody).toContain("data-cp-block");
    const document = new JSDOM(readerBody).window.document;
    const readerShell = document.querySelector("[data-cp-reader]");
    expect(readerShell?.tagName).toBe("DIV");
    const article = readerShell?.querySelector(":scope > article");
    expect(article?.getAttribute("aria-labelledby")).toBe("reader-title");
    expect(article?.querySelector("[data-cp-projected] > .cp-transcript")?.tagName).toBe("DIV");
  });

  test("rejects an invalid item ID at the route boundary", async () => {
    const env = await environment("invalid-item-id");
    const app = buildApp({ db: env.db, config: { ...CONFIG, items_root: env.itemsRoot }, now });
    const response = await app.handle(new Request("http://localhost/items/not-an-item-id", { headers: { cookie: cookie(ALICE) } }));
    expect(response.status).toBe(400);
  });

  test("serve structured text and the frozen saved copy only to the owner", async () => {
    const env = await environment("routes");
    const app = buildApp({ db: env.db, config: { ...CONFIG, items_root: env.itemsRoot }, now });
    const reader = await app.handle(new Request(`http://localhost/items/${env.itemId}`, { headers: { cookie: cookie(ALICE) } }));
    const readerBody = await reader.text();
    const settings = new URLSearchParams({ theme: "auto", font: "jetbrains-mono", text_size: "22", line_spacing: "190", paragraph_spacing: "60", text_width: "80" });
    const saved = await app.handle(new Request("http://localhost/settings", {
      method: "POST",
      headers: { cookie: cookie(ALICE), "content-type": "application/x-www-form-urlencoded" },
      body: settings,
    }));
    expect(saved.status).toBe(303);
    const styledReader = await app.handle(new Request(`http://localhost/items/${env.itemId}`, { headers: { cookie: cookie(ALICE) } }));
    const styledReaderBody = await styledReader.text();
    expect(styledReaderBody).toContain('data-cp-text-size="22"');
    expect(styledReaderBody).not.toContain("data-cp-settings-details");
    const raw = await app.handle(new Request(`http://localhost/items/${env.itemId}/raw`, { headers: { cookie: cookie(ALICE) } }));
    expect(raw.status).toBe(200);
    const rawBody = await raw.text();
    expect(raw.headers.get("content-type")).toContain("text/html");
    expect(rawBody).toContain("Hidden navigation");
    expect(readerBody).not.toContain("Hidden navigation");
    expect(rawBody).not.toBe(readerBody);
    expect(rawBody).toContain("Structured text");
    expect(rawBody).toContain("data-cp-block");
    expect(rawBody).toContain('data-cp-text-size="22"');
    expect(rawBody).not.toContain("data-cp-settings-details");
    expect(rawBody).not.toContain("Page settings");
    const capture = await app.handle(new Request(`http://localhost/items/${env.itemId}/capture`, { headers: { cookie: cookie(ALICE) } }));
    expect(await capture.text()).toBe(env.original);
    const policy = capture.headers.get("content-security-policy")!;
    expect(policy).toContain("sandbox");
    expect(policy).toContain("style-src 'unsafe-inline'");
    expect(policy).toContain("img-src data:");
    expect(policy).toContain("font-src data:");
    expect(policy).toContain("script-src 'none'");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("frame-src 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).not.toContain("http:");
    expect(policy).not.toContain("https:");
    const other = await app.handle(new Request(`http://localhost/items/${env.itemId}`, { headers: { cookie: cookie(BOB) } }));
    expect(other.status).toBe(404);
    const signedOut = await app.handle(new Request(`http://localhost/items/${env.itemId}`));
    expect(signedOut.status).toBe(303);
  });

  test("preserves structured semantics without loading remote images", async () => {
    const env = await environment("structured", ALICE, STRUCTURED_PAGE);
    const app = buildApp({ db: env.db, config: { ...CONFIG, items_root: env.itemsRoot }, now });
    const response = await app.handle(new Request(`http://localhost/items/${env.itemId}/raw`, { headers: { cookie: cookie(ALICE) } }));
    const document = new JSDOM(await response.text()).window.document;
    expect(response.status).toBe(200);
    expect(document.querySelector(".cp-transcript h1")?.textContent).toContain("Structured content");
    expect(document.querySelector("a[href=\"https://example.com/destination\"]")?.textContent).toContain("discoverable link");
    expect(document.querySelector("img[alt=\"Remote diagram\"]")?.getAttribute("src")).toBeNull();
    expect(document.body.innerHTML).not.toContain("https://cdn.example/remote.png");
    expect(document.querySelector("img[alt=\"Embedded diagram\"]")?.getAttribute("src")).toStartWith("data:image/png");
    expect(document.querySelector("ol")).not.toBeNull();
    expect(document.querySelector("ul")).not.toBeNull();
    expect(document.querySelector("blockquote")).not.toBeNull();
    expect(document.querySelector("pre code")?.textContent).toContain("const value = 1;");
    expect(document.querySelector("em")).not.toBeNull();
    expect(document.querySelector("strong")).not.toBeNull();
    expect(document.querySelector("s")).not.toBeNull();
    expect(document.querySelector("table")).not.toBeNull();
    expect(document.querySelector(".cp-table-wrap")).not.toBeNull();
    expect(document.querySelector(".cp-table-wrap")?.getAttribute("role")).toBe("region");
    expect(document.querySelector(".cp-table-wrap")?.getAttribute("tabindex")).toBe("0");
    expect(document.querySelector(".cp-table-wrap")?.getAttribute("aria-label")).toBe("Scrollable table");
    expect(document.querySelector('img[alt="Standalone diagram"]')?.getAttribute("src")).toStartWith("data:image/png");
    expect(document.querySelector("hr")).not.toBeNull();
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("iframe")).toBeNull();
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

  test("captureFile returns the original durable file", async () => {
    const env = await environment("capture-file");
    expect(await captureFile({ db: env.db, itemsRoot: env.itemsRoot }, ALICE, env.itemId)).toBe(env.original);
  });
});
