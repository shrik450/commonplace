import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { JSDOM } from "jsdom";

import { newRequestId, type ItemId, type UserId } from "../../src/contracts/ids";
import type { FetchRequest } from "../../src/contracts/item";
import { ingestRequest } from "../../src/services/ingest";
import { loadTranscript } from "../../src/services/library";
import { listAnnotations } from "../../src/store/annotations";
import { itemDir } from "../../src/store/files";
import { getItem, getItemByUrl } from "../../src/store/items";
import { claimRequest, enqueueFetch, failFetch, getFetchRequest, reserveItem } from "../../src/store/queue";
import {
  ALICE,
  BOB,
  articleHtml,
  get,
  openLibrary,
  postForm,
  savePage,
  type TestLibrary,
} from "../support/library";

const libraries: TestLibrary[] = [];

afterAll(async () => {
  for (const opened of libraries) await opened.close();
});

async function library(name: string): Promise<TestLibrary> {
  const opened = await openLibrary(`removal-${name}`);
  libraries.push(opened);
  return opened;
}

function documentOf(html: string): Document {
  return new JSDOM(html).window.document;
}

const URL_A = "https://example.com/topology";
const PAGE = articleHtml({
  title: "The web as topology",
  paragraphs: [
    "A garden is a web of paths that you can wander in any order you choose.",
    "The stream replaces topology with serialization and keeps only the newest.",
  ],
});

function queue(opened: TestLibrary, owner: UserId, url: string): FetchRequest {
  return enqueueFetch(opened.db, {
    id: newRequestId(),
    user_id: owner,
    item_id: null,
    url,
    state: "queued",
    lease_expires_at: null,
    attempts: 0,
    error_code: null,
    created_at: opened.clock.now.toISOString(),
  });
}

function claim(opened: TestLibrary, request: FetchRequest): FetchRequest {
  return claimRequest(opened.db, request.id, opened.clock.now, 60_000)!;
}

// Runs the rest of an ingest a worker had claimed, as the worker would.
function finishIngest(opened: TestLibrary, request: FetchRequest) {
  return ingestRequest(
    {
      db: opened.db,
      itemsRoot: opened.itemsRoot,
      now: () => opened.clock.now,
      capture: async (capture) => {
        await Bun.write(capture.outputPath, PAGE);
        return { path: capture.outputPath, bytes: PAGE.length };
      },
      browserPath: "/unused",
    },
    request,
  );
}

async function clip(opened: TestLibrary, itemId: ItemId, quote: string): Promise<void> {
  const { transcript } = await loadTranscript({ db: opened.db, itemsRoot: opened.itemsRoot }, ALICE, itemId);
  const start = transcript.indexOf(quote);
  const response = await postForm(opened, `/items/${itemId}/clippings`, {
    start: String(start),
    end: String(start + quote.length),
  });
  expect(response.status).toBe(303);
}

describe("removing a page", () => {
  test("the reader leads to a confirmation that names the page and what goes with it", async () => {
    const opened = await library("confirm");
    const itemId = await savePage(opened, ALICE, URL_A, PAGE);
    await clip(opened, itemId, "A garden is a web of paths");

    const reader = documentOf(await (await get(opened, `/items/${itemId}`)).text());
    const link = reader.querySelector(`a[href="/items/${itemId}/delete"]`);
    expect(link?.textContent).toBe("Remove page…");

    const response = await get(opened, `/items/${itemId}/delete`);
    expect(response.status).toBe(200);
    const confirm = documentOf(await response.text());
    expect(confirm.querySelector("h1")?.textContent).toContain("The web as topology");
    expect(confirm.body.textContent).toContain("1 clipping");
    expect(confirm.querySelector(`form[action="/items/${itemId}/delete"][method="post"] button`)?.textContent).toContain("Remove page");
    expect(confirm.querySelector(`a[href="/items/${itemId}"]`)?.textContent).toContain("Cancel");
    expect(getItem(opened.db, ALICE, itemId)).not.toBeNull();
  });

  test("removing takes the page, its clippings, its search text, and its files", async () => {
    const opened = await library("remove");
    const itemId = await savePage(opened, ALICE, URL_A, PAGE);
    const kept = await savePage(opened, ALICE, "https://example.com/kept", articleHtml({
      title: "A page that stays",
      paragraphs: ["This page also talks about topology, and it stays in the library."],
    }));
    await clip(opened, itemId, "A garden is a web of paths");
    const [done] = opened.db
      .query<{ id: string }, [string]>("SELECT id FROM fetch_requests WHERE item_id = ?")
      .all(itemId);

    const removed = await postForm(opened, `/items/${itemId}/delete`, {});
    expect(removed.status).toBe(303);
    expect(removed.headers.get("location")).toBe("/library");

    expect(getItem(opened.db, ALICE, itemId)).toBeNull();
    expect(listAnnotations(opened.db, ALICE, itemId)).toEqual([]);
    expect(existsSync(itemDir(opened.itemsRoot, ALICE, itemId))).toBe(false);
    expect((await get(opened, `/items/${itemId}`)).status).toBe(404);
    expect((await get(opened, `/saves/${done!.id}`)).status).toBe(404);

    const search = documentOf(await (await get(opened, "/search?q=topology")).text());
    expect(search.querySelector(`a[href^="/items/${itemId}"]`)).toBeNull();
    expect(search.querySelector(`a[href^="/items/${kept}"]`)).not.toBeNull();
    expect(
      opened.db.query<{ count: number }, [string]>("SELECT count(*) AS count FROM blocks_fts WHERE item_id = ?").get(itemId)!.count,
    ).toBe(0);

    const shelf = await (await get(opened, "/library")).text();
    expect(shelf).not.toContain(`/items/${itemId}`);
    expect(shelf).toContain(`/items/${kept}`);
    const book = await (await get(opened, "/clippings")).text();
    expect(book).not.toContain("A garden is a web of paths");
  });

  test("the same address can be saved again as a new page after removal", async () => {
    const opened = await library("resave");
    const first = await savePage(opened, ALICE, URL_A, PAGE);
    await postForm(opened, `/items/${first}/delete`, {});
    const second = await savePage(opened, ALICE, URL_A, PAGE);
    expect(second).not.toBe(first);
    expect((await get(opened, `/items/${second}`)).status).toBe(200);
  });

  test("a save of the same address still in progress is cancelled with the page", async () => {
    const opened = await library("recapture");
    const itemId = await savePage(opened, ALICE, URL_A, PAGE);
    const waiting = queue(opened, ALICE, URL_A);
    const running = claim(opened, queue(opened, ALICE, URL_A));
    expect(reserveItem(opened.db, running.id, running.attempts, itemId)).toBe(true);

    expect((await postForm(opened, `/items/${itemId}/delete`, {})).status).toBe(303);

    const outcome = await finishIngest(opened, running);
    expect(outcome.state).toBe("failed");
    expect(getItem(opened.db, ALICE, itemId)).toBeNull();
    expect(getItemByUrl(opened.db, ALICE, URL_A)).toBeNull();
    expect(getFetchRequest(opened.db, ALICE, waiting.id)).toBeNull();
    expect(await (await get(opened, "/library")).text()).not.toContain(URL_A);
  });

  test("only the owner can remove a page", async () => {
    const opened = await library("tenancy");
    const itemId = await savePage(opened, ALICE, URL_A, PAGE);
    expect((await get(opened, `/items/${itemId}/delete`, BOB)).status).toBe(404);
    expect((await postForm(opened, `/items/${itemId}/delete`, {}, BOB)).status).toBe(404);
    const anonymous = await postForm(opened, `/items/${itemId}/delete`, {}, null);
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get("location")).not.toBe("/library");
    expect(getItem(opened.db, ALICE, itemId)).not.toBeNull();
    expect(existsSync(itemDir(opened.itemsRoot, ALICE, itemId))).toBe(true);
    expect((await get(opened, "/items/not-an-id/delete")).status).toBe(400);
    expect((await postForm(opened, "/items/not-an-id/delete", {})).status).toBe(400);
  });
});

describe("removing a save", () => {
  test("a waiting save leads to a confirmation, then leaves the library", async () => {
    const opened = await library("save-waiting");
    const waiting = queue(opened, ALICE, "https://example.com/mistake");

    const status = documentOf(await (await get(opened, `/saves/${waiting.id}`)).text());
    expect(status.querySelector(`a[href="/saves/${waiting.id}/delete"]`)?.textContent).toBe("Remove save…");

    const confirm = documentOf(await (await get(opened, `/saves/${waiting.id}/delete`)).text());
    expect(confirm.body.textContent).toContain("https://example.com/mistake");
    expect(confirm.querySelector(`form[action="/saves/${waiting.id}/delete"][method="post"] button`)?.textContent).toContain("Remove save");
    expect(confirm.querySelector(`a[href="/saves/${waiting.id}"]`)?.textContent).toContain("Cancel");

    const removed = await postForm(opened, `/saves/${waiting.id}/delete`, {});
    expect(removed.status).toBe(303);
    expect(removed.headers.get("location")).toBe("/library");
    expect(getFetchRequest(opened.db, ALICE, waiting.id)).toBeNull();
    expect((await get(opened, `/saves/${waiting.id}`)).status).toBe(404);
    expect(await (await get(opened, "/library")).text()).not.toContain("https://example.com/mistake");
  });

  test("a failed save can be removed", async () => {
    const opened = await library("save-failed");
    const running = claim(opened, queue(opened, ALICE, "https://example.com/broken"));
    failFetch(opened.db, running.id, running.attempts, "ACQUIRE_FAILED");
    const status = documentOf(await (await get(opened, `/saves/${running.id}`)).text());
    expect(status.querySelector(`a[href="/saves/${running.id}/delete"]`)).not.toBeNull();
    expect((await postForm(opened, `/saves/${running.id}/delete`, {})).status).toBe(303);
    expect(getFetchRequest(opened.db, ALICE, running.id)).toBeNull();
  });

  test("a first save in progress can be removed, and its capture never becomes a page", async () => {
    const opened = await library("save-running");
    const running = claim(opened, queue(opened, ALICE, URL_A));
    expect((await postForm(opened, `/saves/${running.id}/delete`, {})).status).toBe(303);
    const outcome = await finishIngest(opened, running);
    expect(outcome.state).toBe("failed");
    expect(getItemByUrl(opened.db, ALICE, URL_A)).toBeNull();
  });

  test("a save refreshing a page already in the library can't be removed mid-capture", async () => {
    const opened = await library("save-refresh");
    const itemId = await savePage(opened, ALICE, URL_A, PAGE);
    const running = claim(opened, queue(opened, ALICE, URL_A));
    expect(reserveItem(opened.db, running.id, running.attempts, itemId)).toBe(true);

    const status = documentOf(await (await get(opened, `/saves/${running.id}`)).text());
    expect(status.querySelector(`a[href="/saves/${running.id}/delete"]`)).toBeNull();
    const refused = await postForm(opened, `/saves/${running.id}/delete`, {});
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain(`/items/${itemId}`);
    expect(getFetchRequest(opened.db, ALICE, running.id)?.state).toBe("claimed");
  });

  test("a finished save points to its page instead", async () => {
    const opened = await library("save-done");
    const itemId = await savePage(opened, ALICE, URL_A, PAGE);
    const [done] = opened.db
      .query<{ id: string }, [string]>("SELECT id FROM fetch_requests WHERE item_id = ?")
      .all(itemId);
    const refused = await postForm(opened, `/saves/${done!.id}/delete`, {});
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain(`/items/${itemId}/delete`);
    expect(getItem(opened.db, ALICE, itemId)).not.toBeNull();
  });

  test("only the owner can remove a save", async () => {
    const opened = await library("save-tenancy");
    const waiting = queue(opened, ALICE, "https://example.com/private");
    expect((await get(opened, `/saves/${waiting.id}/delete`, BOB)).status).toBe(404);
    expect((await postForm(opened, `/saves/${waiting.id}/delete`, {}, BOB)).status).toBe(404);
    expect(getFetchRequest(opened.db, ALICE, waiting.id)).not.toBeNull();
    expect((await postForm(opened, "/saves/not-an-id/delete", {})).status).toBe(400);
  });
});
