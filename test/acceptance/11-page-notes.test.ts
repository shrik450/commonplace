import { afterAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import { NOTE_MAX_LENGTH } from "../../src/contracts/clipping";
import { asPageNoteId, newPageNoteId, type ItemId, type PageNoteId } from "../../src/contracts/ids";
import { loadTranscript } from "../../src/services/library";
import { insertPageNote } from "../../src/store/page-notes";
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
  const opened = await openLibrary(`page-notes-${name}`);
  libraries.push(opened);
  return opened;
}

function documentOf(html: string): Document {
  return new JSDOM(html).window.document;
}

const URL_PAPER = "https://craigmod.com/paper";
const PAPER = articleHtml({
  title: "Paper is a very good technology",
  paragraphs: [
    "Paper forgets nothing and asks for nothing. It has no notifications at all.",
    "The margin is where the reader talks back to the writer.",
  ],
});

async function note(opened: TestLibrary, itemId: ItemId, text: string, owner = ALICE): Promise<Response> {
  return postForm(opened, `/items/${itemId}/page-notes`, { note: text }, owner);
}

async function clip(opened: TestLibrary, itemId: ItemId, quote: string): Promise<void> {
  const { transcript } = await loadTranscript({ db: opened.db, itemsRoot: opened.itemsRoot }, ALICE, itemId);
  const start = transcript.indexOf(quote);
  expect(start).toBeGreaterThanOrEqual(0);
  const response = await postForm(opened, `/items/${itemId}/clippings`, { start: String(start), end: String(start + quote.length) });
  expect(response.status).toBe(303);
}

function noteIds(document: Document): PageNoteId[] {
  return [...document.querySelectorAll<HTMLElement>("[data-page-note]")].map((element) => asPageNoteId(element.dataset.pageNote ?? ""));
}

describe("writing notes on a page", () => {
  test("the reader ends with the page's notes, oldest first, and a form for another", async () => {
    const opened = await library("write");
    const itemId = await savePage(opened, ALICE, URL_PAPER, PAPER);

    const empty = documentOf(await (await get(opened, `/items/${itemId}`)).text());
    const form = empty.querySelector(`form[action="/items/${itemId}/page-notes"][method="post"]`);
    expect(form?.querySelector('textarea[name="note"]')).not.toBeNull();
    const projected = empty.querySelector("[data-cp-projected]")!;
    expect(projected.compareDocumentPosition(form!) & 4).toBe(4);

    const first = await note(opened, itemId, "  Read this beside the essay on marginalia.  ");
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toBe(`/items/${itemId}#page-notes`);
    await note(opened, itemId, "The argument is really about attention.");

    const reader = documentOf(await (await get(opened, `/items/${itemId}`)).text());
    const section = reader.getElementById("page-notes")!;
    const texts = [...section.querySelectorAll("[data-page-note]")].map((element) => element.textContent ?? "");
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain("Read this beside the essay on marginalia.");
    expect(texts[0]).not.toContain("  Read");
    expect(texts[1]).toContain("The argument is really about attention.");
    const [id] = noteIds(reader);
    expect(section.querySelector(`a[href="/page-notes/${id}"]`)).not.toBeNull();
  });

  test("a blank note or an overlong one is refused, and nothing is kept", async () => {
    const opened = await library("refuse");
    const itemId = await savePage(opened, ALICE, URL_PAPER, PAPER);
    expect((await note(opened, itemId, "   ")).status).toBe(400);
    const tooLong = await note(opened, itemId, "x".repeat(NOTE_MAX_LENGTH + 1));
    expect(tooLong.status).toBe(400);
    expect(await tooLong.text()).toContain(`${NOTE_MAX_LENGTH} characters`);
    const reader = documentOf(await (await get(opened, `/items/${itemId}`)).text());
    expect(noteIds(reader)).toEqual([]);
  });

  test("a note can be edited on its own page, and a blank edit is refused", async () => {
    const opened = await library("edit");
    const itemId = await savePage(opened, ALICE, URL_PAPER, PAPER);
    await note(opened, itemId, "First thought.");
    const [id] = noteIds(documentOf(await (await get(opened, `/items/${itemId}`)).text()));

    const page = documentOf(await (await get(opened, `/page-notes/${id}`)).text());
    expect(page.querySelector(`form[action="/page-notes/${id}"] textarea[name="note"]`)?.textContent).toBe("First thought.");
    expect(page.querySelector(`a[href="/items/${itemId}"]`)).not.toBeNull();
    expect(page.querySelector(`a[href="/page-notes/${id}/delete"]`)?.textContent).toBe("Remove note…");

    const saved = await postForm(opened, `/page-notes/${id}`, { note: "Second thought." });
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe(`/items/${itemId}#page-notes`);
    expect((await postForm(opened, `/page-notes/${id}`, { note: "" })).status).toBe(400);
    const reader = await (await get(opened, `/items/${itemId}`)).text();
    expect(reader).toContain("Second thought.");
    expect(reader).not.toContain("First thought.");
  });

  test("removing a note asks first", async () => {
    const opened = await library("remove");
    const itemId = await savePage(opened, ALICE, URL_PAPER, PAPER);
    await note(opened, itemId, "A note to throw away.");
    const [id] = noteIds(documentOf(await (await get(opened, `/items/${itemId}`)).text()));

    const confirm = documentOf(await (await get(opened, `/page-notes/${id}/delete`)).text());
    expect(confirm.body.textContent).toContain("A note to throw away.");
    expect(confirm.body.textContent).toContain("Paper is a very good technology");
    expect(confirm.querySelector(`form[action="/page-notes/${id}/delete"][method="post"] button`)?.textContent).toContain("Remove note");
    expect(confirm.querySelector(`a[href="/page-notes/${id}"]`)?.textContent).toContain("Cancel");

    const removed = await postForm(opened, `/page-notes/${id}/delete`, {});
    expect(removed.status).toBe(303);
    expect(removed.headers.get("location")).toBe(`/items/${itemId}#page-notes`);
    expect(await (await get(opened, `/items/${itemId}`)).text()).not.toContain("A note to throw away.");
    expect((await get(opened, `/page-notes/${id}`)).status).toBe(404);
  });

  test("notes belong to their owner", async () => {
    const opened = await library("tenancy");
    const itemId = await savePage(opened, ALICE, URL_PAPER, PAPER);
    await note(opened, itemId, "Alice's private thought.");
    const [id] = noteIds(documentOf(await (await get(opened, `/items/${itemId}`)).text()));

    expect((await note(opened, itemId, "Bob's intrusion.", BOB)).status).toBe(404);
    for (const [method, path] of [["GET", `/page-notes/${id}`], ["GET", `/page-notes/${id}/delete`], ["POST", `/page-notes/${id}`], ["POST", `/page-notes/${id}/delete`]] as const) {
      const response = method === "GET" ? await get(opened, path, BOB) : await postForm(opened, path, { note: "Bob's edit." }, BOB);
      expect(response.status).toBe(404);
    }
    expect(documentOf(await (await get(opened, "/clippings", BOB)).text()).body.textContent).not.toContain("Alice's private thought.");
    const reader = documentOf(await (await get(opened, `/items/${itemId}`)).text()).body.textContent;
    expect(reader).toContain("Alice's private thought.");
    expect(reader).not.toContain("Bob's");
    expect((await get(opened, "/page-notes/not-an-id")).status).toBe(400);
  });

  test("notes stay when the page is saved again, and go when it is removed", async () => {
    const opened = await library("lifecycle");
    const itemId = await savePage(opened, ALICE, URL_PAPER, PAPER);
    await note(opened, itemId, "Kept across a fresh capture.");
    expect(await savePage(opened, ALICE, URL_PAPER, PAPER)).toBe(itemId);
    expect(await (await get(opened, `/items/${itemId}`)).text()).toContain("Kept across a fresh capture.");

    const confirm = await (await get(opened, `/items/${itemId}/delete`)).text();
    expect(confirm).toContain("1 page note");
    await postForm(opened, `/items/${itemId}/delete`, {});
    expect(await (await get(opened, "/clippings")).text()).not.toContain("Kept across a fresh capture.");
  });
});

describe("page notes in the book and the library", () => {
  async function stocked(name: string) {
    const opened = await library(name);
    const paper = await savePage(opened, ALICE, URL_PAPER, PAPER);
    const index = await savePage(opened, ALICE, "https://thebrowser.com/index", articleHtml({
      title: "A brief history of the index",
      paragraphs: ["The index was invented not to aid memory but to replace it, and readers complained."],
    }));
    await clip(opened, paper, "The margin is where the reader talks back");
    await note(opened, paper, "Paper as a place to argue.");
    await note(opened, index, "Nothing worth clipping, but the idea stays with me.");
    return { opened, paper, index };
  }

  test("a page's notes follow its clippings, and a page with only notes has a place", async () => {
    const { opened, paper, index } = await stocked("book");
    const book = documentOf(await (await get(opened, "/clippings")).text());
    expect(book.body.textContent).toContain("1 clipping and 2 page notes from 2 pages");
    const loci = [...book.querySelectorAll("[data-locus]")];
    expect(loci.map((locus) => locus.querySelector("h2")?.textContent)).toEqual([
      "A brief history of the index",
      "Paper is a very good technology",
    ]);
    expect(loci[0]!.querySelector("[data-page-note]")?.textContent).toContain("Nothing worth clipping");
    const entries = [...loci[1]!.querySelectorAll("[data-clipping], [data-page-note]")];
    expect(entries.map((entry) => entry.hasAttribute("data-clipping"))).toEqual([true, false]);
    const paperNote = loci[1]!.querySelector<HTMLElement>("[data-page-note]")!.dataset.pageNote;
    expect(loci[1]!.querySelector(`a[href="/page-notes/${paperNote}"]`)).not.toBeNull();

    const one = documentOf(await (await get(opened, `/clippings?item=${index}`)).text());
    expect(one.body.textContent).toContain("1 page note from this page");
    expect(one.body.textContent).not.toContain("This page has no clippings");
    const both = documentOf(await (await get(opened, `/clippings?item=${paper}`)).text());
    expect(both.body.textContent).toContain("1 clipping and 1 page note from this page");
  });

  test("every page note counts as a note, and shuffles on its own", async () => {
    const { opened } = await stocked("filters");
    const notes = documentOf(await (await get(opened, "/clippings?notes=1")).text());
    expect(notes.querySelectorAll("[data-clipping]")).toHaveLength(0);
    expect(notes.querySelectorAll("[data-page-note]")).toHaveLength(2);
    expect(notes.body.textContent).toContain("Showing the 2 page notes");

    const shuffled = documentOf(await (await get(opened, "/clippings?order=shuffle&seed=7")).text());
    const loci = [...shuffled.querySelectorAll("[data-locus]")];
    expect(loci).toHaveLength(3);
    for (const locus of loci) expect(locus.querySelectorAll("[data-clipping], [data-page-note]")).toHaveLength(1);
  });

  test("the library card and the reader's ribbon count page notes", async () => {
    const { opened, paper, index } = await stocked("counts");
    const shelf = documentOf(await (await get(opened, "/library")).text());
    const card = (itemId: ItemId) => shelf.querySelector(`a[href="/items/${itemId}"]`)!.textContent ?? "";
    expect(card(paper)).toContain("1 clipping · 1 page note");
    expect(card(index)).toContain("1 page note");
    expect(card(index)).not.toContain("clipping");

    const reader = documentOf(await (await get(opened, `/items/${index}`)).text());
    const ribbon = reader.querySelector(`a.ribbon[href="/clippings?item=${index}"]`);
    expect(ribbon?.textContent).toBe("1");
    expect(ribbon?.getAttribute("aria-label")).toBe("1 page note from this page");
  });

  test("page notes fill volumes like clippings", async () => {
    const opened = await library("volumes");
    const items: ItemId[] = [];
    for (let index = 0; index < 6; index += 1) {
      const itemId = await savePage(opened, ALICE, `https://example.com/volume-${index}`, articleHtml({
        title: `Volume source ${index}`,
        paragraphs: ["Each of these pages carries many notes to fill the book."],
      }));
      items.push(itemId);
      for (let count = 0; count < 50; count += 1) {
        insertPageNote(opened.db, {
          id: newPageNoteId(),
          user_id: ALICE,
          item_id: itemId,
          body: `Note ${count} on page ${index}`,
          created_at: "2026-06-01T00:00:00.000Z",
          updated_at: "2026-06-01T00:00:00.000Z",
        });
      }
    }
    const first = documentOf(await (await get(opened, "/clippings")).text());
    expect(first.querySelectorAll("[data-locus]")).toHaveLength(3);
    const older = first.querySelector('a[href^="/clippings?before="]');
    expect(older).not.toBeNull();
    const second = documentOf(await (await get(opened, older!.getAttribute("href")!)).text());
    expect([...second.querySelectorAll("[data-locus] h2")].map((heading) => heading.textContent)).toEqual([
      "Volume source 2",
      "Volume source 1",
      "Volume source 0",
    ]);
  });
});
