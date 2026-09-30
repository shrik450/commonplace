import { afterAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import { formatCursor, parseCursor } from "../../src/contracts/cursor";
import { newAnnotationId, newItemId, newRequestId, type ItemId, type UserId } from "../../src/contracts/ids";
import type { Item } from "../../src/contracts/item";
import { libraryPage } from "../../src/services/library";
import { insertAnnotation } from "../../src/store/annotations";
import { indexBlocks } from "../../src/store/fts";
import { insertItem } from "../../src/store/items";
import { claimRequest, enqueueFetch, failFetch } from "../../src/store/queue";
import {
  ALICE,
  BOB,
  articleHtml,
  get,
  openLibrary,
  savePage,
  type TestLibrary,
} from "../support/library";

const libraries: TestLibrary[] = [];

async function library(name: string): Promise<TestLibrary> {
  const opened = await openLibrary(`library-${name}`);
  libraries.push(opened);
  return opened;
}

afterAll(async () => {
  for (const opened of libraries) await opened.close();
});

function documentOf(html: string): Document {
  return new JSDOM(html).window.document;
}

// Inserts bare item rows, one second apart, oldest first. The library listing
// never reads item files, so paging tests don't need a full ingest.
function fillItems(opened: TestLibrary, owner: UserId, count: number): Item[] {
  const items: Item[] = [];
  for (let index = 0; index < count; index += 1) {
    const created = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
    items.push(insertItem(opened.db, {
      id: newItemId(),
      user_id: owner,
      url: `https://example.com/${owner}/${index}`,
      title: `Card ${index}`,
      author: null,
      created_at: created,
      ingested_at: created,
      excerpt: "",
      content_length: 0,
    }));
  }
  return items;
}

function clipRows(opened: TestLibrary, owner: UserId, itemId: ItemId, count: number): void {
  for (let index = 0; index < count; index += 1) {
    insertAnnotation(opened.db, {
      id: newAnnotationId(),
      user_id: owner,
      item_id: itemId,
      start_offset: index,
      end_offset: index + 1,
      quote: "x",
      note: null,
      created_at: "2026-02-01T00:00:00.000Z",
      updated_at: "2026-02-01T00:00:00.000Z",
    });
  }
}

const LONG_PARAGRAPH = "Readers copied passages under headings so that a sentence met once could be found again. ".repeat(14);

describe("library cards", () => {
  test("a card shows the excerpt, site, author, reading time, and clippings", async () => {
    const opened = await library("card");
    const itemId = await savePage(opened, ALICE, "https://www.publicdomainreview.org/commonplace", articleHtml({
      title: "Notes on the commonplace book",
      author: "Ann Blair",
      paragraphs: ["Short opening line.", LONG_PARAGRAPH, LONG_PARAGRAPH],
    }));
    clipRows(opened, ALICE, itemId, 3);

    const response = await get(opened, "/library");
    expect(response.status).toBe(200);
    const document = documentOf(await response.text());
    const card = document.querySelector(`a[href="/items/${itemId}"]`)?.closest("li");
    expect(card).not.toBeNull();
    const text = card!.textContent ?? "";
    expect(text).toContain("Notes on the commonplace book");
    expect(text).toContain("Readers copied passages under headings");
    expect(text).not.toContain("Short opening line.");
    expect(text).toContain("publicdomainreview.org");
    expect(text).toContain("Ann Blair");
    expect(text).toContain("2 min read");
    expect(text).toContain("3 clippings");
    expect(card!.querySelector("time")?.getAttribute("datetime")).toMatch(/^2026-05-01T/);
  });

  test("a page with no long passage has no excerpt, and one clipping is singular", async () => {
    const opened = await library("card-short");
    const itemId = await savePage(opened, ALICE, "https://example.com/short", articleHtml({
      title: "A short note",
      paragraphs: ["Only a line."],
    }));
    clipRows(opened, ALICE, itemId, 1);
    const document = documentOf(await (await get(opened, "/library")).text());
    const card = document.querySelector(`a[href="/items/${itemId}"]`)!.closest("li")!;
    expect(card.textContent).toContain("1 clipping");
    expect(card.textContent).not.toContain("1 clippings");
    expect(card.textContent).toContain("1 min read");
    expect(card.querySelector("[data-card-excerpt]")).toBeNull();
  });

  test("the header's library tab counts every card, and marks the current view", async () => {
    const opened = await library("count");
    fillItems(opened, ALICE, 3);
    fillItems(opened, BOB, 5);
    const document = documentOf(await (await get(opened, "/library")).text());
    const tab = document.querySelector('nav a[href="/library"]');
    expect(tab?.getAttribute("aria-current")).toBe("page");
    expect(tab?.textContent).toContain("3");
    const search = documentOf(await (await get(opened, "/search?q=card")).text());
    expect(search.querySelector('nav a[href="/library"]')?.hasAttribute("aria-current")).toBe(false);
  });

  test("an empty library says how to save a first page", async () => {
    const opened = await library("empty");
    const body = await (await get(opened, "/library")).text();
    expect(body).toContain("Your library is empty");
    expect(documentOf(body).querySelector('form[action="/items"] input[name="url"]')).not.toBeNull();
  });
});

describe("library pages", () => {
  test("pages walk the whole library in both directions with honest counts", async () => {
    const opened = await library("pages");
    const items = fillItems(opened, ALICE, 7).toReversed();
    fillItems(opened, BOB, 4);
    const deps = { db: opened.db, itemsRoot: opened.itemsRoot };

    const first = libraryPage(deps, ALICE, { kind: "newest" }, 3);
    expect(first.cards.map((card) => card.item.id)).toEqual(items.slice(0, 3).map((item) => item.id));
    expect(first).toMatchObject({ total: 7, newerCount: 0, olderCount: 4, newer: null });

    const second = libraryPage(deps, ALICE, { kind: "before", cursor: first.older! }, 3);
    expect(second.cards.map((card) => card.item.id)).toEqual(items.slice(3, 6).map((item) => item.id));
    expect(second).toMatchObject({ total: 7, newerCount: 3, olderCount: 1 });

    const last = libraryPage(deps, ALICE, { kind: "before", cursor: second.older! }, 3);
    expect(last.cards.map((card) => card.item.id)).toEqual([items[6]!.id]);
    expect(last).toMatchObject({ newerCount: 6, olderCount: 0, older: null });

    const back = libraryPage(deps, ALICE, { kind: "after", cursor: last.newer! }, 3);
    expect(back.cards.map((card) => card.item.id)).toEqual(items.slice(3, 6).map((item) => item.id));
    const top = libraryPage(deps, ALICE, { kind: "after", cursor: back.newer! }, 3);
    expect(top.cards.map((card) => card.item.id)).toEqual(items.slice(0, 3).map((item) => item.id));
    expect(top.newer).toBeNull();
  });

  test("items saved in the same millisecond still page without gaps or repeats", async () => {
    const opened = await library("same-time");
    for (let index = 0; index < 5; index += 1) {
      insertItem(opened.db, {
        id: newItemId(),
        user_id: ALICE,
        url: `https://example.com/same/${index}`,
        title: `Same ${index}`,
        author: null,
        created_at: "2026-03-01T00:00:00.000Z",
        ingested_at: null,
        excerpt: "",
        content_length: 0,
      });
    }
    const deps = { db: opened.db, itemsRoot: opened.itemsRoot };
    const seen: string[] = [];
    let page = libraryPage(deps, ALICE, { kind: "newest" }, 2);
    seen.push(...page.cards.map((card) => card.item.id));
    while (page.older !== null) {
      page = libraryPage(deps, ALICE, { kind: "before", cursor: page.older }, 2);
      seen.push(...page.cards.map((card) => card.item.id));
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  test("the routes link older and newer pages and reject malformed links", async () => {
    const opened = await library("page-links");
    const items = fillItems(opened, ALICE, 205).toReversed();
    const first = documentOf(await (await get(opened, "/library")).text());
    expect(first.querySelectorAll(`a[href^="/items/"]`)).toHaveLength(200);
    expect(first.querySelector('a[href^="/library?after="]')).toBeNull();
    const older = first.querySelector<HTMLAnchorElement>('a[href^="/library?before="]');
    expect(older?.textContent).toContain("Older cards");
    expect(parseCursor(new URL(older!.href, "http://localhost").searchParams.get("before")!).id).toBe(items[199]!.id);

    const secondResponse = await get(opened, older!.getAttribute("href")!);
    expect(secondResponse.status).toBe(200);
    const second = documentOf(await secondResponse.text());
    expect(second.querySelectorAll(`a[href^="/items/"]`)).toHaveLength(5);
    expect(second.querySelector('a[href^="/library?before="]')).toBeNull();
    const newer = second.querySelector<HTMLAnchorElement>('a[href^="/library?after="]');
    expect(newer?.textContent).toContain("Newer cards");
    const box = second.querySelector("[data-index-box]");
    expect(box?.getAttribute("data-newer-count")).toBe("200");
    expect(box?.getAttribute("data-older-count")).toBe("0");

    for (const path of [
      "/library?before=nonsense",
      `/library?before=2026-01-01_${items[0]!.id}`,
      "/library?after=2026-01-01T00:00:00.000Z_not-an-id",
      `/library?before=${formatCursor(items[3]!)}&after=${formatCursor(items[1]!)}`,
    ]) {
      const response = await get(opened, path);
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("VIEW_INVALID_CURSOR");
    }

    const beyond = await get(opened, `/library?before=${formatCursor(items[204]!)}`);
    expect(beyond.status).toBe(303);
    expect(beyond.headers.get("location")).toBe("/library");
  });

  test("another reader's cursor reveals nothing of their library", async () => {
    const opened = await library("page-tenant");
    const bobs = fillItems(opened, BOB, 3);
    fillItems(opened, ALICE, 2);
    const response = await get(opened, `/library?before=${formatCursor(bobs[2]!)}`);
    const body = await response.text();
    for (const item of bobs) expect(body).not.toContain(item.id);
  });
});

describe("save cards", () => {
  test("waiting and failed saves stand at the front of the first page only", async () => {
    const opened = await library("save-cards");
    const items = fillItems(opened, ALICE, 205);
    const waiting = enqueueFetch(opened.db, {
      id: newRequestId(),
      user_id: ALICE,
      item_id: null,
      url: "https://example.com/waiting",
      state: "queued",
      lease_expires_at: null,
      attempts: 0,
      error_code: null,
      created_at: "2026-06-01T00:00:00.000Z",
    });
    const failing = enqueueFetch(opened.db, { ...waiting, id: newRequestId(), url: "https://example.com/broken" });
    const claimed = claimRequest(opened.db, failing.id, new Date(), 60_000)!;
    failFetch(opened.db, claimed.id, claimed.attempts, "ACQUIRE_FAILED");

    const document = documentOf(await (await get(opened, "/library")).text());
    const waitingCard = document.querySelector(`a[href="/saves/${waiting.id}"]`)?.closest("li");
    const failedCard = document.querySelector(`a[href="/saves/${failing.id}"]`)?.closest("li");
    expect(waitingCard?.textContent).toContain("https://example.com/waiting");
    expect(waitingCard?.textContent).toContain("Waiting to save…");
    expect(failedCard?.textContent).toContain("Save failed");
    const cards = [...document.querySelectorAll("[data-index-box] li")];
    expect(cards.indexOf(waitingCard!)).toBeLessThan(cards.indexOf(document.querySelector(`a[href="/items/${items[204]!.id}"]`)!.closest("li")!));

    const older = document.querySelector('a[href^="/library?before="]')!.getAttribute("href")!;
    const second = await (await get(opened, older)).text();
    expect(second).not.toContain("/saves/");
  });
});

describe("saving pages", () => {
  test("the save page and the header both post a link to the save endpoint", async () => {
    const opened = await library("save-page");
    const response = await get(opened, "/save");
    expect(response.status).toBe(200);
    const document = documentOf(await response.text());
    const form = document.querySelector('main form[action="/items"][method="post"]');
    expect(form?.querySelector('input[name="url"][type="url"]')?.hasAttribute("required")).toBe(true);
    expect(form?.querySelector('button[type="submit"]')?.textContent).toContain("Save page");
    expect(document.querySelector('header form[action="/items"] input[name="url"]')).not.toBeNull();

    const signedOut = await get(opened, "/save", null);
    expect(signedOut.status).toBe(303);
  });
});

describe("search", () => {
  test("results are cards under a stamped count, with matches marked", async () => {
    const opened = await library("search");
    const itemId = await savePage(opened, ALICE, "https://example.com/memory", articleHtml({
      title: "An outboard memory",
      paragraphs: ["A notebook is an outboard memory that never asks you to sign in again."],
      aside: "Related: memory machines",
    }));
    await savePage(opened, BOB, "https://example.com/bob-memory", articleHtml({
      title: "Bob's memory",
      paragraphs: ["Bob also writes about memory."],
    }));
    const document = documentOf(await (await get(opened, "/search?q=memory")).text());
    expect(document.querySelector("h1")?.textContent).toContain("memory");
    const results = [...document.querySelectorAll("main ol > li")];
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(document.querySelector("[data-stamp]")?.textContent).toBe(`${results.length} found`);
    expect(results.every((result) => result.querySelector(`a[href^="/items/${itemId}#b"]`) !== null)).toBe(true);
    expect(document.querySelector("mark, .cp-hit")?.textContent?.toLowerCase()).toBe("memory");
    expect(document.body.textContent).toContain("This match appears outside the article content.");
    expect(document.body.textContent).not.toContain("Bob also writes");
    expect(document.querySelector('header input[name="q"]')?.getAttribute("value")).toBe("memory");

    const nothing = await (await get(opened, "/search?q=zeppelin")).text();
    expect(nothing).toContain("Nothing matches");
  });
});

describe("search limits", () => {
  test("a capped search says there were more", async () => {
    const opened = await library("search-cap");
    for (const item of fillItems(opened, ALICE, 31)) {
      indexBlocks(opened.db, item.id, [{
        item_id: item.id,
        user_id: ALICE,
        block_index: 0,
        start_offset: 0,
        end_offset: 30,
        is_content: true,
        text: "every page mentions the marginalia",
      }]);
    }
    const capped = documentOf(await (await get(opened, "/search?q=marginalia")).text());
    expect(capped.querySelectorAll("main ol > li")).toHaveLength(30);
    expect(capped.querySelector("[data-stamp]")?.textContent).toBe("30+ found");
  });
});

describe("client scripts", () => {
  test("only listed scripts are served, as JavaScript", async () => {
    const opened = await library("scripts");
    const box = await get(opened, "/scripts/index-box.js", null);
    expect(box.status).toBe(200);
    expect(box.headers.get("content-type")).toContain("text/javascript");
    expect((await box.text()).length).toBeGreaterThan(0);
    for (const path of ["/scripts/unknown.js", "/scripts/..%2Fapp.js", "/scripts/index-box"]) {
      expect((await get(opened, path, null)).status).toBe(404);
    }
  });

  test("each view asks for the scripts that enhance it", async () => {
    const opened = await library("page-scripts");
    const scripts = async (path: string) =>
      [...documentOf(await (await get(opened, path)).text()).querySelectorAll("script[src]")].map((script) => script.getAttribute("src"));
    expect(await scripts("/library")).toContain("/scripts/index-box.js");
    expect(await scripts("/clippings")).toContain("/scripts/book.js");
    expect(await scripts("/settings")).toContain("/scripts/reading-settings.js");
    for (const path of ["/library", "/clippings", "/settings", "/search"]) {
      expect(await scripts(path)).toContain("/scripts/save-card.js");
    }
  });
});
