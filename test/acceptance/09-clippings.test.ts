import { afterAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import { NOTE_MAX_LENGTH } from "../../src/contracts/clipping";
import { newAnnotationId, type ItemId, type UserId } from "../../src/contracts/ids";
import { commonplaceBook, VOLUME_SIZE } from "../../src/services/clippings";
import { loadTranscript } from "../../src/services/library";
import { getAnnotation, insertAnnotation, listAnnotations } from "../../src/store/annotations";
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

const GARDEN = articleHtml({
  title: "The garden and the stream",
  author: "Mike Caulfield",
  paragraphs: [
    "I find it hard to communicate with a lot of technologists anymore, and the web is where it shows most.",
    "The garden is the web as topology. The web as space. It is the integrative web, the iterative web.",
    "The stream replaces topology with serialization, and puts our own experience at the centre of it.",
  ],
  aside: "Related posts and other navigation that is not part of the article.",
});

type Garden = { opened: TestLibrary; itemId: ItemId; transcript: string };

async function garden(name: string, owner: UserId = ALICE): Promise<Garden> {
  const opened = await openLibrary(`clippings-${name}`);
  libraries.push(opened);
  const itemId = await savePage(opened, owner, "https://hapgood.us/garden", GARDEN);
  const { transcript } = await loadTranscript({ db: opened.db, itemsRoot: opened.itemsRoot }, owner, itemId);
  return { opened, itemId, transcript };
}

type RangeFields = { start: string; end: string };

function rangeOf(transcript: string, quote: string): RangeFields {
  const start = transcript.indexOf(quote);
  if (start === -1) throw new Error(`fixture quote missing: ${quote}`);
  return { start: String(start), end: String(start + quote.length) };
}

function documentOf(html: string): Document {
  return new JSDOM(html).window.document;
}

describe("making a clipping", () => {
  test("the quote comes from the saved page, trimmed, and the reader returns to it", async () => {
    const { opened, itemId, transcript } = await garden("create");
    const quote = "The garden is the web as topology.";
    const range = rangeOf(transcript, quote);
    const response = await postForm(opened, `/items/${itemId}/clippings`, {
      start: String(Number(range.start) - 1),
      end: String(Number(range.end) + 1),
      quote: "a forged quote the server must ignore",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toMatch(new RegExp(`^/items/${itemId}#b\\d+$`));
    const [clipping] = listAnnotations(opened.db, ALICE, itemId);
    expect(clipping?.quote).toBe(quote);
    expect(clipping?.note).toBeNull();

    const reader = documentOf(await (await get(opened, `/items/${itemId}`)).text());
    const marks = reader.querySelectorAll(`mark[data-cp-annotation="${clipping!.id}"]`);
    expect([...marks].map((mark) => mark.textContent).join("")).toBe(quote);
  });

  test("a clipping can carry its note from the start, and a blank note is no note", async () => {
    const { opened, itemId, transcript } = await garden("create-note");
    const response = await postForm(opened, `/items/${itemId}/clippings`, {
      ...rangeOf(transcript, "The web as space."),
      note: "  Space, not time.  ",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toMatch(new RegExp(`^/items/${itemId}#b\\d+$`));
    await postForm(opened, `/items/${itemId}/clippings`, { ...rangeOf(transcript, "The stream replaces"), note: "   " });
    const notes = listAnnotations(opened.db, ALICE, itemId).map((clipping) => [clipping.quote, clipping.note]);
    expect(notes).toEqual([["The web as space.", "Space, not time."], ["The stream replaces", null]]);

    const tooLong = await postForm(opened, `/items/${itemId}/clippings`, {
      ...rangeOf(transcript, "The garden is"),
      note: "x".repeat(NOTE_MAX_LENGTH + 1),
    });
    expect(tooLong.status).toBe(400);
    expect(await tooLong.text()).toContain(`${NOTE_MAX_LENGTH} characters`);
    expect(listAnnotations(opened.db, ALICE, itemId)).toHaveLength(2);
  });

  test("a clipping may span paragraphs but never text outside the article", async () => {
    const { opened, itemId, transcript } = await garden("create-bounds");
    const across = {
      start: String(transcript.indexOf("iterative web.")),
      end: String(transcript.indexOf("The stream replaces") + "The stream replaces".length),
    };
    expect((await postForm(opened, `/items/${itemId}/clippings`, across)).status).toBe(303);

    const outside = rangeOf(transcript, "Related posts and other navigation");
    const cases = [
      outside,
      { start: across.start, end: String(transcript.length) },
      { start: "-1", end: "5" },
      { start: "40", end: "40" },
      { start: "50", end: "40" },
      { start: "10", end: String(transcript.length + 10) },
      { start: "ten", end: "20" },
      { start: "1.5", end: "20" },
      { start: "", end: "20" },
    ];
    for (const fields of cases) {
      const response = await postForm(opened, `/items/${itemId}/clippings`, fields);
      expect(response.status).toBe(400);
    }
    const blank = transcript.indexOf("\n");
    if (blank !== -1) {
      const response = await postForm(opened, `/items/${itemId}/clippings`, { start: String(blank), end: String(blank + 1) });
      expect(response.status).toBe(400);
    }
    expect(listAnnotations(opened.db, ALICE, itemId)).toHaveLength(1);
  });

  test("only the owner can clip a page, and signing in comes first", async () => {
    const { opened, itemId, transcript } = await garden("create-tenant");
    const fields = rangeOf(transcript, "The web as space.");
    expect((await postForm(opened, `/items/${itemId}/clippings`, fields, BOB)).status).toBe(404);
    const signedOut = await postForm(opened, `/items/${itemId}/clippings`, fields, null);
    expect(signedOut.status).toBe(303);
    expect(signedOut.headers.get("location")).toBe("/login");
    expect((await postForm(opened, "/items/not-an-id/clippings", fields)).status).toBe(400);
    expect(listAnnotations(opened.db, ALICE, itemId)).toHaveLength(0);
  });
});

describe("reading a clipped page", () => {
  test("each clipping is numbered once in the margin, at its first segment", async () => {
    const { opened, itemId, transcript } = await garden("margin");
    await postForm(opened, `/items/${itemId}/clippings`, {
      start: String(transcript.indexOf("iterative web.")),
      end: String(transcript.indexOf("The stream replaces") + "The stream replaces".length),
    });
    await postForm(opened, `/items/${itemId}/clippings`, rangeOf(transcript, "hard to communicate"));
    const reader = documentOf(await (await get(opened, `/items/${itemId}`)).text());
    const firsts = [...reader.querySelectorAll("mark[data-cp-first]")];
    expect(firsts.map((mark) => mark.textContent)).toEqual(["hard to communicate", "iterative web."]);
    const spanning = listAnnotations(opened.db, ALICE, itemId).find((clipping) => clipping.quote.startsWith("iterative"))!;
    expect(reader.querySelectorAll(`mark[data-cp-annotation="${spanning.id}"]`).length).toBeGreaterThan(1);

    const ribbon = reader.querySelector(`a[href="/clippings?item=${itemId}"]`);
    expect(ribbon?.textContent).toContain("2");
    expect(ribbon?.getAttribute("aria-label")).toBe("2 clippings from this page");
  });

  test("an unclipped page has no ribbon and offers the clipping form to scripts", async () => {
    const { opened, itemId } = await garden("margin-empty");
    const reader = documentOf(await (await get(opened, `/items/${itemId}`)).text());
    expect(reader.querySelector('a[href^="/clippings?item="]')).toBeNull();
    const form = reader.querySelector(`form[action="/items/${itemId}/clippings"][method="post"]`);
    expect(form?.hasAttribute("hidden")).toBe(true);
    expect(form?.querySelector('input[name="start"]')).not.toBeNull();
    expect([...reader.querySelectorAll("script[src]")].map((script) => script.getAttribute("src"))).toContain("/scripts/clip.js");
  });
});

describe("editing and removing a clipping", () => {
  test("a note is saved trimmed, cleared when blank, and limited in length", async () => {
    const { opened, itemId, transcript } = await garden("note");
    await postForm(opened, `/items/${itemId}/clippings`, rangeOf(transcript, "The web as space."));
    const [clipping] = listAnnotations(opened.db, ALICE, itemId);

    const saved = await postForm(opened, `/clippings/${clipping!.id}`, { note: "  Feeds vs. files.  " });
    expect(saved.status).toBe(303);
    expect(getAnnotation(opened.db, ALICE, clipping!.id)?.note).toBe("Feeds vs. files.");

    await postForm(opened, `/clippings/${clipping!.id}`, { note: "   " });
    expect(getAnnotation(opened.db, ALICE, clipping!.id)?.note).toBeNull();

    const long = await postForm(opened, `/clippings/${clipping!.id}`, { note: "x".repeat(2_001) });
    expect(long.status).toBe(400);
    expect(await long.text()).toContain("Shorten the note");
    expect(getAnnotation(opened.db, ALICE, clipping!.id)?.note).toBeNull();
  });

  test("removing asks first, then removes only the owner's clipping", async () => {
    const { opened, itemId, transcript } = await garden("remove");
    await postForm(opened, `/items/${itemId}/clippings`, rangeOf(transcript, "The web as space."));
    const [clipping] = listAnnotations(opened.db, ALICE, itemId);
    const path = `/clippings/${clipping!.id}`;

    const confirm = documentOf(await (await get(opened, `${path}/delete`)).text());
    expect(confirm.body.textContent).toContain("The garden and the stream");
    expect(confirm.body.textContent).toContain("The web as space.");
    expect(confirm.querySelector(`form[action="${path}/delete"][method="post"] button`)?.textContent).toContain("Remove clipping");
    const edit = documentOf(await (await get(opened, path)).text());
    expect(edit.querySelector(`a[href="${path}/delete"]`)?.textContent).toContain("…");

    for (const [method, target] of [["GET", path], ["GET", `${path}/delete`], ["POST", path], ["POST", `${path}/delete`]] as const) {
      const response = method === "GET" ? await get(opened, target, BOB) : await postForm(opened, target, { note: "mine now" }, BOB);
      expect(response.status).toBe(404);
    }
    expect((await get(opened, "/clippings/not-an-id")).status).toBe(400);

    const removed = await postForm(opened, `${path}/delete`, {});
    expect(removed.status).toBe(303);
    expect(removed.headers.get("location")).toBe(`/items/${itemId}`);
    expect(getAnnotation(opened.db, ALICE, clipping!.id)).toBeNull();
    expect((await get(opened, path)).status).toBe(404);
  });
});

describe("the commonplace book", () => {
  async function stocked(name: string) {
    const opened = await openLibrary(`book-${name}`);
    libraries.push(opened);
    const paper = await savePage(opened, ALICE, "https://craigmod.com/paper", articleHtml({
      title: "Paper is a very good technology",
      paragraphs: ["Paper forgets nothing and asks for nothing. It has no notifications at all.", "The margin is where the reader talks back to the writer."],
    }));
    const index = await savePage(opened, ALICE, "https://thebrowser.com/index", articleHtml({
      title: "A brief history of the index",
      paragraphs: ["The index was invented not to aid memory but to replace it, and readers complained."],
    }));
    const bobs = await savePage(opened, BOB, "https://example.com/bob", articleHtml({
      title: "Bob's private page",
      paragraphs: ["Bob keeps his own clippings about something else entirely."],
    }));
    const clip = async (owner: UserId, itemId: ItemId, quote: string, note?: string) => {
      const { transcript } = await loadTranscript({ db: opened.db, itemsRoot: opened.itemsRoot }, owner, itemId);
      const response = await postForm(opened, `/items/${itemId}/clippings`, rangeOf(transcript, quote), owner);
      expect(response.status).toBe(303);
      if (note !== undefined) {
        const clipping = listAnnotations(opened.db, owner, itemId).find((candidate) => candidate.quote === quote)!;
        await postForm(opened, `/clippings/${clipping.id}`, { note }, owner);
      }
    };
    await clip(ALICE, paper, "The margin is where the reader talks back");
    await clip(ALICE, paper, "Paper forgets nothing", "That is the feeling the reader should have.");
    await clip(ALICE, index, "invented not to aid memory");
    await clip(BOB, bobs, "Bob keeps his own clippings");
    return { opened, paper, index };
  }

  test("the book holds only your clippings, newest page first, in reading order", async () => {
    const { opened, paper, index } = await stocked("order");
    const response = await get(opened, "/clippings");
    expect(response.status).toBe(200);
    const document = documentOf(await response.text());
    expect(document.querySelector('nav a[href="/clippings"]')?.getAttribute("aria-current")).toBe("page");
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("Bob keeps");
    expect(text).toContain("3 clippings from 2 pages");
    const loci = [...document.querySelectorAll("[data-locus]")];
    expect(loci.map((locus) => locus.querySelector("h2")?.textContent)).toEqual([
      "A brief history of the index",
      "Paper is a very good technology",
    ]);
    const quotes = [...loci[1]!.querySelectorAll("blockquote")].map((quote) => quote.textContent);
    expect(quotes).toEqual(["Paper forgets nothing", "The margin is where the reader talks back"]);
    expect(loci[1]!.textContent).toContain("That is the feeling the reader should have.");
    expect(loci[1]!.querySelector(`a[href="/items/${paper}"]`)).not.toBeNull();
    expect(loci[0]!.id).toBe(`item-${index}`);
  });

  test("filters narrow the book to notes, or to one page", async () => {
    const { opened, paper } = await stocked("filters");
    const notes = documentOf(await (await get(opened, "/clippings?notes=1")).text());
    expect([...notes.querySelectorAll("blockquote")].map((quote) => quote.textContent)).toEqual(["Paper forgets nothing"]);
    expect(notes.querySelector('a[href="/clippings?notes=1"]')?.getAttribute("aria-current")).toBe("page");

    expect(notes.body.textContent).toContain("Showing the 1 clipping with notes");

    const one = documentOf(await (await get(opened, `/clippings?item=${paper}`)).text());
    expect(one.querySelectorAll("blockquote")).toHaveLength(2);
    expect(one.body.textContent).toContain("2 clippings from this page");
    expect(one.body.textContent).not.toContain("invented not to aid memory");
    expect((await get(opened, "/clippings?item=bogus")).status).toBe(400);
  });

  test("a shuffled book keeps its order for the same seed", async () => {
    const { opened } = await stocked("shuffle");
    const quotes = async (path: string) =>
      [...documentOf(await (await get(opened, path)).text()).querySelectorAll("blockquote")].map((quote) => quote.textContent);
    const first = await quotes("/clippings?order=shuffle&seed=7");
    expect(first).toHaveLength(3);
    expect(await quotes("/clippings?order=shuffle&seed=7")).toEqual(first);
    const document = documentOf(await (await get(opened, "/clippings")).text());
    expect(document.querySelector('a[href^="/clippings?order=shuffle&seed="]')).not.toBeNull();
    expect((await get(opened, "/clippings?order=shuffle&seed=x")).status).toBe(400);
    expect((await get(opened, "/clippings?order=sideways")).status).toBe(400);
  });

  test("an empty book explains where clippings come from", async () => {
    const opened = await openLibrary("book-empty");
    libraries.push(opened);
    const body = await (await get(opened, "/clippings")).text();
    expect(body).toContain("Your commonplace book is empty");
    expect((await get(opened, "/clippings", null)).status).toBe(303);
  });

  test("a large book splits into volumes of whole pages", async () => {
    const opened = await openLibrary("book-volumes");
    libraries.push(opened);
    const items: ItemId[] = [];
    for (let index = 0; index < 3; index += 1) {
      items.push(await savePage(opened, ALICE, `https://example.com/volume-${index}`, articleHtml({
        title: `Volume source ${index}`,
        paragraphs: ["Each of these pages is clipped many times over to fill the book."],
      })));
    }
    for (const itemId of items) {
      for (let index = 0; index < 50; index += 1) {
        insertAnnotation(opened.db, {
          id: newAnnotationId(),
          user_id: ALICE,
          item_id: itemId,
          start_offset: index,
          end_offset: index + 4,
          quote: "Each",
          note: null,
          created_at: "2026-06-01T00:00:00.000Z",
          updated_at: "2026-06-01T00:00:00.000Z",
        });
      }
    }
    const deps = { db: opened.db, itemsRoot: opened.itemsRoot };
    const filter = { notesOnly: false, itemId: null, order: { kind: "by-page" } as const };
    const first = commonplaceBook(deps, ALICE, filter, { kind: "newest" });
    expect(VOLUME_SIZE).toBe(120);
    expect(first.loci.map((locus) => locus.item.id)).toEqual([items[2], items[1], items[0]]);
    expect(first.clippings).toBe(150);
    expect(first.older).toBeNull();

    for (let index = 0; index < 3; index += 1) {
      items.push(await savePage(opened, ALICE, `https://example.com/volume-late-${index}`, articleHtml({
        title: `Late source ${index}`,
        paragraphs: ["A later page, clipped just as often, pushes the rest into a second volume."],
      })));
      for (let clip = 0; clip < 50; clip += 1) {
        insertAnnotation(opened.db, {
          id: newAnnotationId(),
          user_id: ALICE,
          item_id: items.at(-1)!,
          start_offset: clip,
          end_offset: clip + 1,
          quote: "A",
          note: null,
          created_at: "2026-06-02T00:00:00.000Z",
          updated_at: "2026-06-02T00:00:00.000Z",
        });
      }
    }
    const newest = commonplaceBook(deps, ALICE, filter, { kind: "newest" });
    expect(newest.loci).toHaveLength(3);
    expect(newest.older).not.toBeNull();
    const second = commonplaceBook(deps, ALICE, filter, { kind: "before", cursor: newest.older! });
    expect(second.loci.map((locus) => locus.item.id)).toEqual([items[2], items[1], items[0]]);
    expect(second.newer).not.toBeNull();
    const back = commonplaceBook(deps, ALICE, filter, { kind: "after", cursor: second.newer! });
    expect(back.loci.map((locus) => locus.item.id)).toEqual(newest.loci.map((locus) => locus.item.id));

    const page = documentOf(await (await get(opened, "/clippings")).text());
    const older = page.querySelector('a[href^="/clippings?before="]');
    expect(older?.textContent).toContain("Next volume");
    expect((await get(opened, older!.getAttribute("href")!)).status).toBe(200);
  });
});
