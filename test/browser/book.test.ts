import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Browser, Page } from "playwright-core";

import type { ItemId } from "../../src/contracts/ids";
import { listAnnotations } from "../../src/store/annotations";
import { launch, PHONE, serve, visit, type Served, type Visit, type VisitOptions } from "../support/browser";
import { seedDemo } from "../support/demo";
import { ALICE, openLibrary, type TestLibrary } from "../support/library";

setDefaultTimeout(60_000);

let library: TestLibrary;
let served: Served;
let browser: Browser;
let ids: ItemId[];
const visits: Visit[] = [];

beforeAll(async () => {
  library = await openLibrary("browser-book");
  ids = await seedDemo(library, ALICE);
  served = serve(library);
  browser = await launch();
});

afterAll(async () => {
  for (const current of visits) await current.close();
  await browser.close();
  served.stop();
  await library.close();
});

async function openBook(options: VisitOptions = {}, path = "/clippings"): Promise<Visit> {
  const current = await visit(browser, served, ALICE, options);
  visits.push(current);
  await current.page.goto(`${served.origin}${path}`, { waitUntil: "networkidle" });
  if (options.scripts === false) await current.page.waitForTimeout(300);
  else await current.page.evaluate(() => document.fonts.ready);
  return current;
}

const count = (page: Page) => page.locator("[data-page-count]").textContent();

// Reduced motion shortens transitions to nearly nothing rather than none, so
// layout settles once the last of them has run.
const settle = (page: Page) =>
  page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));

// Which loci show, whole or in part, through the book's page window.
async function visibleLoci(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const window = document.querySelector(".book-window")!.getBoundingClientRect();
    return [...document.querySelectorAll("[data-flow] [data-locus]")]
      .filter((locus) => [...locus.getClientRects()].some((rect) => rect.right > window.left + 1 && rect.left < window.right - 1))
      .map((locus) => locus.querySelector("h2")!.textContent!);
  });
}

describe("the commonplace book", () => {
  test("opens on the title page, two pages wide, and fills the window", async () => {
    const { page, errors } = await openBook();
    expect(await page.locator("[data-book]").getAttribute("data-paged")).toBe("");
    expect(await count(page)).toMatch(/^Pages 1–2 of \d+$/);
    expect(await page.getByRole("button", { name: "‹ Previous" }).isDisabled()).toBe(true);
    expect(await page.getByRole("button", { name: "Previous page" }).isVisible()).toBe(false);
    const still = await page.evaluate(() => document.scrollingElement!.scrollHeight <= innerHeight);
    expect(still).toBe(true);
    expect(errors).toEqual([]);
  });

  test("turning a page runs a leaf across, then leaves only the new spread", async () => {
    const { page, errors } = await openBook();
    await page.getByRole("button", { name: "Next ›" }).click();
    expect(await page.locator(".leaf").count()).toBe(1);
    expect(await page.locator(".leaf .leaf-face").count()).toBe(2);
    expect(await count(page)).toMatch(/^Pages 3–4 of/);
    await page.waitForTimeout(800);
    expect(await page.locator(".leaf, .leaf-face").count()).toBe(0);
    expect(await page.locator("[data-folio=left]").first().textContent()).toBe("3");

    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(800);
    expect(await count(page)).toMatch(/^Pages 1–2 of/);
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(800);
    expect(await count(page)).toMatch(/^Pages 3–4 of/);
    expect(errors).toEqual([]);
  });

  test("turning again mid-turn finishes the first turn at once", async () => {
    const { page } = await openBook();
    const next = page.getByRole("button", { name: "Next ›" });
    await next.click();
    await next.click();
    await next.click();
    expect(await page.locator(".leaf").count()).toBe(1);
    expect(await count(page)).toMatch(/^Pages 7–8 of/);
    await page.waitForTimeout(800);
    expect(await page.locator(".leaf, .leaf-face").count()).toBe(0);
  });

  test("every clipping appears on some page, and the last page stops the book", async () => {
    const { page } = await openBook({ reducedMotion: "reduce" });
    const all = await page.locator("[data-flow] [data-locus] h2").allTextContents();
    const seen = new Set<string>(await visibleLoci(page));
    const next = page.getByRole("button", { name: "Next ›" });
    for (let turns = 0; turns < 40 && !(await next.isDisabled()); turns += 1) {
      await next.click();
      await settle(page);
      for (const title of await visibleLoci(page)) seen.add(title);
    }
    expect(await next.isDisabled()).toBe(true);
    const missing = [...new Set(all)].filter((title) => !seen.has(title));
    expect(missing).toEqual([]);
    const [, last, total] = (await count(page))!.match(/(\d+)(?:–\d+)? of (\d+)/)!.concat();
    expect(Number(total)).toBeGreaterThanOrEqual(Number(last));
  });

  test("tabbing to a link on another page opens the book there", async () => {
    const { page } = await openBook({ reducedMotion: "reduce" });
    const links = page.locator("[data-flow] a");
    const total = await links.count();
    for (let index = 0; index < total; index += 1) {
      await links.nth(index).focus();
      await settle(page);
      const placed = await page.evaluate(() => {
        const window = document.querySelector(".book-window")!;
        const frame = window.getBoundingClientRect();
        const link = document.activeElement!.getBoundingClientRect();
        return { scrolled: window.scrollLeft, inside: link.left >= frame.left - 1 && link.right <= frame.right + 1 };
      });
      expect(placed).toEqual({ scrolled: 0, inside: true });
    }
  });

  test("with reduced motion, pages change without a leaf", async () => {
    const { page } = await openBook({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Next ›" }).click();
    expect(await page.locator(".leaf").count()).toBe(0);
    expect(await count(page)).toMatch(/^Pages 3–4 of/);
  });

  test("on a narrow window the book shows one page, and turns back over it", async () => {
    const { page, errors } = await openBook({ viewport: PHONE, hasTouch: true });
    expect(await count(page)).toMatch(/^Page 1 of \d+$/);
    await page.getByRole("button", { name: "Next ›" }).click();
    await page.waitForTimeout(800);
    expect(await count(page)).toMatch(/^Page 2 of/);
    await page.getByRole("button", { name: "‹ Previous" }).click();
    // Turning back, the leaf lands over the page before the spread changes.
    expect(await count(page)).toMatch(/^Page 2 of/);
    await page.waitForTimeout(800);
    expect(await count(page)).toMatch(/^Page 1 of/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  });

  test("a link to a page's clippings opens the book where they are", async () => {
    const target = ids.at(-1)!;
    const { page } = await openBook({}, `/clippings#item-${target}`);
    const title = await page.locator(`#item-${target} h2`).textContent();
    expect(await visibleLoci(page)).toContain(title!);
  });

  test("resizing keeps the page you were reading in view", async () => {
    const { page } = await openBook({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Next ›" }).click();
    await page.getByRole("button", { name: "Next ›" }).click();
    await settle(page);
    const before = await visibleLoci(page);
    await page.setViewportSize(PHONE);
    await page.waitForTimeout(300);
    await settle(page);
    expect(await count(page)).toMatch(/^Page \d+ of/);
    const after = await visibleLoci(page);
    expect(after.some((title) => before.includes(title))).toBe(true);
  });

  test("without a script the book is one scrolling page with every clipping", async () => {
    const { page } = await openBook({ scripts: false });
    expect(await page.locator("[data-book]").getAttribute("data-paged")).toBeNull();
    expect(await page.locator("[data-turns]").isVisible()).toBe(false);
    const layout = await page.evaluate(() => ({
      scrolls: document.scrollingElement!.scrollHeight > innerHeight,
      quotes: document.querySelectorAll("blockquote").length,
    }));
    expect(layout.scrolls).toBe(true);
    expect(layout.quotes).toBeGreaterThan(5);
    await page.getByRole("link", { name: "With notes" }).click();
    await page.waitForLoadState("networkidle");
    expect(page.url()).toContain("notes=1");
  });
});

const noteStatus = (page: Page, message: string) =>
  page.waitForFunction((text) => document.querySelector("[data-note-status]")?.textContent === text, message);

// Whether the element shows through the book's page window.
const inWindow = (page: Page, selector: string) =>
  page.evaluate((target) => {
    const frame = document.querySelector(".book-window")!.getBoundingClientRect();
    const box = document.querySelector(target)!.getBoundingClientRect();
    return box.left >= frame.left - 1 && box.right <= frame.right + 1 && box.width > 0;
  }, selector);

describe("writing a note in the book", () => {
  // The demo's pages, oldest first, as `seedDemo` clips them: page 3 has one
  // clipping with no note, page 0 one with a note, page 9 two with none.
  const demoPage = (index: number) => ids.at(-1 - index)!;
  const notesOf = (itemId: ItemId) => listAnnotations(library.db, ALICE, itemId).map((clipping) => clipping.note);

  test("Add a note writes the note on the clipping, without leaving the book", async () => {
    const itemId = demoPage(3);
    const { page, errors } = await openBook({}, `/clippings?item=${itemId}`);
    const address = page.url();
    await page.getByRole("link", { name: "Add a note" }).click();
    const field = page.getByLabel("Your note");
    await field.waitFor();
    expect(page.url()).toBe(address);
    expect(await field.evaluate((element) => element === document.activeElement)).toBe(true);
    expect(await page.getByRole("link", { name: "Add a note" }).count()).toBe(0);
    expect(await page.getByRole("link", { name: "Remove clipping…" }).getAttribute("href")).toMatch(/\/clippings\/[0-9a-f-]+\/delete$/);

    await page.keyboard.type("  Written in the book.  ");
    await page.getByRole("button", { name: "Save note" }).click();
    await noteStatus(page, "Note saved.");
    expect(page.url()).toBe(address);
    expect(notesOf(itemId)).toEqual(["Written in the book."]);
    expect(await page.locator(".clipping-note").allTextContents()).toEqual(["Written in the book."]);
    expect(await page.getByLabel("Your note").count()).toBe(0);
    // Focus returns to the link, which now edits the note.
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Edit note");
    expect(errors).toEqual([]);
  });

  test("Edit note starts from the note; Escape keeps edits, Cancel discards them, and clearing removes the note", async () => {
    const itemId = demoPage(0);
    const { page } = await openBook({}, `/clippings?item=${itemId}`);
    const field = page.getByLabel("Your note");

    await page.getByRole("link", { name: "Edit note" }).click();
    expect(await field.inputValue()).toBe("This is why the habit matters.");
    await page.keyboard.press("Escape");
    expect(await field.count()).toBe(0);
    expect(await page.locator(".clipping-note").isVisible()).toBe(true);

    await page.getByRole("link", { name: "Edit note" }).click();
    await page.keyboard.type(" And more.");
    await page.keyboard.press("Escape");
    expect(await field.inputValue()).toBe("This is why the habit matters. And more.");
    await page.getByRole("button", { name: "Cancel" }).click();
    expect(await field.count()).toBe(0);
    expect(notesOf(itemId)).toEqual(["This is why the habit matters."]);

    await page.getByRole("link", { name: "Edit note" }).click();
    await field.fill("");
    await page.keyboard.press("Control+Enter");
    await noteStatus(page, "Note removed.");
    expect(notesOf(itemId)).toEqual([null]);
    expect(await page.locator(".clipping-note").count()).toBe(0);
    expect(await page.getByRole("link", { name: "Add a note" }).isVisible()).toBe(true);
  });

  test("a note that can't be saved says why and keeps what was written", async () => {
    const itemId = demoPage(9);
    const { page } = await openBook({}, `/clippings?item=${itemId}`);
    await page.getByRole("link", { name: "Add a note" }).first().click();
    await page.keyboard.type("Written while offline.");
    await page.route("**/clippings/*", (route) => (route.request().method() === "POST" ? route.abort("internetdisconnected") : route.continue()));
    await page.getByRole("button", { name: "Save note" }).click();
    await page.getByRole("alert").waitFor();
    expect(await page.getByRole("alert").textContent()).toContain("couldn't be reached");
    expect(await page.getByLabel("Your note").inputValue()).toBe("Written while offline.");
    expect(notesOf(itemId)).toEqual([null, null]);

    await page.unroute("**/clippings/*");
    await page.getByRole("button", { name: "Save note" }).click();
    await noteStatus(page, "Note saved.");
    expect(notesOf(itemId).filter((note) => note !== null)).toEqual(["Written while offline."]);
    // The page's other clipping was left as it was.
    expect(await page.getByRole("link", { name: "Add a note" }).count()).toBe(1);
  });

  test("in With notes, clearing a note takes the clipping out of the view", async () => {
    const { page } = await openBook({}, "/clippings?notes=1");
    const before = await page.locator("[data-flow] [data-clipping]").count();
    expect(before).toBeGreaterThan(1);
    await page.getByRole("link", { name: "Edit note" }).first().click();
    await page.getByLabel("Your note").fill("");
    await page.getByRole("button", { name: "Save note" }).click();
    await noteStatus(page, "Note removed.");
    expect(await page.locator("[data-flow] [data-clipping]").count()).toBe(before - 1);
    expect(await page.locator(".title-page").textContent()).toContain(`Showing the ${before - 1} clippings with notes`);
    expect(await count(page)).toMatch(/^Pages? 1/);
  });

  test("on a later page, the clipping being written on stays in view", async () => {
    const { page } = await openBook({ reducedMotion: "reduce", viewport: PHONE, hasTouch: true });
    for (let turns = 0; turns < 3; turns += 1) await page.getByRole("button", { name: "Next ›" }).click();
    await settle(page);
    const label = await count(page);
    const id = await page.evaluate(() => {
      const frame = document.querySelector(".book-window")!.getBoundingClientRect();
      const shown = [...document.querySelectorAll<HTMLElement>("[data-flow] [data-clipping]")].find((scrap) => {
        const box = scrap.getBoundingClientRect();
        return box.left >= frame.left - 1 && box.right <= frame.right + 1;
      })!;
      shown.querySelector<HTMLElement>("[data-note-edit]")!.click();
      return shown.dataset.clipping!;
    });
    await page.getByLabel("Your note").waitFor();
    await settle(page);
    expect(await inWindow(page, `[data-clipping="${id}"] textarea`)).toBe(true);
    await page.keyboard.type("Still here.");
    await page.getByRole("button", { name: "Save note" }).click();
    await noteStatus(page, "Note saved.");
    await settle(page);
    expect(await inWindow(page, `[data-clipping="${id}"] .clipping-note`)).toBe(true);
    expect(label).toMatch(/^Page \d+ of \d+$/);
  });

  test("without a script, Add a note leads to the clipping's own page", async () => {
    const { page } = await openBook({ scripts: false }, `/clippings?item=${demoPage(13)}`);
    await page.getByRole("link", { name: "Add a note" }).click();
    await page.waitForURL(/\/clippings\/[0-9a-f-]+$/);
    expect(await page.getByLabel("Your note").isVisible()).toBe(true);
  });
});
