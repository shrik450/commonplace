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
  library = await openLibrary("browser-reader");
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

async function open(path: string, options: VisitOptions = {}): Promise<Visit> {
  const current = await visit(browser, served, ALICE, options);
  visits.push(current);
  await current.page.goto(`${served.origin}${path}`, { waitUntil: "networkidle" });
  await current.page.evaluate(() => document.fonts.ready);
  return current;
}

// Drags across the nth paragraph of the article, from `from` to `to` pixels
// in from its left edge, and returns the text the browser selected.
async function dragAcross(page: Page, nth: number, from: number, to: number): Promise<string> {
  const paragraph = page.locator(".reader-text p").nth(nth);
  await paragraph.scrollIntoViewIfNeeded();
  const box = (await paragraph.boundingBox())!;
  await page.mouse.move(box.x + from, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + to, box.y + 10, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  return page.evaluate(() => document.getSelection()!.toString());
}

const popVisible = (page: Page) => page.locator("[data-clip-pop]").isVisible();

// Where the window is scrolled, and the reader's address.
const place = (page: Page) => page.evaluate(() => ({ scrollY: Math.round(scrollY), url: location.href }));
const marksOf = (page: Page, clippingId: string) => page.locator(`mark[data-cp-annotation="${clippingId}"]`).allTextContents();
const saved = (page: Page, message: string) => page.waitForFunction((text) => document.querySelector("[data-clip-status]")?.textContent === text, message);

describe("clipping from the reader", () => {
  // Pages with no clippings yet, one for each test that clips.
  const unclipped = () => ids.filter((id) => listAnnotations(library.db, ALICE, id).length === 0);

  test("selecting a passage offers the pop-up beside it, and Clip it keeps exactly that passage in place", async () => {
    const itemId = unclipped()[0]!;
    const { page, errors } = await open(`/items/${itemId}`);
    expect(await popVisible(page)).toBe(false);
    await page.evaluate(() => scrollTo(0, 150));
    const selected = await dragAcross(page, 3, 30, 360);
    expect(selected.trim().length).toBeGreaterThan(20);
    expect(await popVisible(page)).toBe(true);
    const pop = (await page.locator("[data-clip-pop]").boundingBox())!;
    const paragraph = (await page.locator(".reader-text p").nth(3).boundingBox())!;
    expect(pop.y + pop.height).toBeLessThanOrEqual(paragraph.y + 4);

    const before = await place(page);
    expect(before.scrollY).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Clip it" }).click();
    await saved(page, "Clipped.");
    expect(await place(page)).toEqual(before);
    expect(await popVisible(page)).toBe(false);
    expect(await page.evaluate(() => document.getSelection()!.isCollapsed)).toBe(true);
    const [clipping] = listAnnotations(library.db, ALICE, itemId);
    expect(clipping?.quote).toBe(selected.trim());
    expect(clipping?.note).toBeNull();
    expect((await marksOf(page, clipping!.id)).join("")).toBe(selected.trim());
    const number = await page.locator("mark[data-cp-first]").first().evaluate((mark) => {
      const margin = getComputedStyle(mark, "::before");
      return { position: margin.position, width: margin.width, content: margin.content };
    });
    expect(number).toEqual({ position: "absolute", width: "24px", content: "counter(clipping) / \"\"" });
    expect(await page.getByRole("link", { name: "1 clipping from this page" }).isVisible()).toBe(true);
    expect(errors).toEqual([]);
  });

  test("clippings made one after another each get a number, without leaving the page", async () => {
    const itemId = unclipped()[0]!;
    const { page, errors } = await open(`/items/${itemId}`);
    const before = await place(page);
    await dragAcross(page, 2, 30, 300);
    await page.getByRole("button", { name: "Clip it" }).click();
    await saved(page, "Clipped.");
    await dragAcross(page, 1, 30, 300);
    await page.getByRole("button", { name: "Clip it" }).click();
    await page.getByRole("link", { name: "2 clippings from this page" }).waitFor();
    expect((await place(page)).url).toBe(before.url);
    const clippings = listAnnotations(library.db, ALICE, itemId);
    expect(clippings).toHaveLength(2);
    const numbered = await page.locator("mark[data-cp-first]").evaluateAll((marks) => marks.map((mark) => mark.getAttribute("data-cp-annotation")));
    expect(numbered.toSorted()).toEqual(clippings.map((clipping) => clipping.id).toSorted());
    expect(errors).toEqual([]);
  });

  test("a selection across paragraphs clips the whole passage", async () => {
    const itemId = unclipped()[0]!;
    const { page } = await open(`/items/${itemId}`);
    const first = (await page.locator(".reader-text p").nth(1).boundingBox())!;
    const second = (await page.locator(".reader-text p").nth(2).boundingBox())!;
    await page.mouse.move(first.x + 40, first.y + 10);
    await page.mouse.down();
    await page.mouse.move(second.x + 120, second.y + 10, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(150);
    await page.getByRole("button", { name: "Clip it" }).click();
    await saved(page, "Clipped.");
    const [clipping] = listAnnotations(library.db, ALICE, itemId);
    expect(clipping?.quote).toContain("\n");
    expect(await page.locator(`mark[data-cp-annotation="${clipping!.id}"]`).count()).toBeGreaterThan(1);
    expect(await page.locator("mark[data-cp-first]").count()).toBe(1);
  });

  test("Add a note opens a slip below the passage, and saving it clips with the note in place", async () => {
    const itemId = unclipped()[0]!;
    const { page, errors } = await open(`/items/${itemId}`);
    const selected = await dragAcross(page, 3, 20, 300);
    const before = await place(page);
    await page.getByRole("button", { name: "Add a note" }).click();
    const slip = page.getByRole("group", { name: "Note on this clipping" });
    await slip.waitFor();
    expect(await popVisible(page)).toBe(false);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("clip-note");
    // The passage stays marked while the note has focus.
    expect(await page.evaluate(() => CSS.highlights.get("cp-pending")?.size)).toBe(1);
    const slipBox = (await slip.boundingBox())!;
    const paragraph = (await page.locator(".reader-text p").nth(3).boundingBox())!;
    expect(slipBox.y).toBeGreaterThan(paragraph.y);
    expect(slipBox.x).toBeGreaterThanOrEqual(paragraph.x - 1);
    expect(slipBox.x + slipBox.width).toBeLessThanOrEqual(paragraph.x + paragraph.width + 1);

    await page.keyboard.type("A note written in the reader.");
    await page.getByRole("button", { name: "Save clipping" }).click();
    await saved(page, "Clipped, with your note.");
    expect((await place(page)).url).toBe(before.url);
    expect(await slip.isVisible()).toBe(false);
    expect(await page.evaluate(() => CSS.highlights.has("cp-pending"))).toBe(false);
    const [clipping] = listAnnotations(library.db, ALICE, itemId);
    expect(clipping?.quote).toBe(selected.trim());
    expect(clipping?.note).toBe("A note written in the reader.");
    expect((await marksOf(page, clipping!.id)).join("")).toBe(selected.trim());
    expect(errors).toEqual([]);
  });

  test("the note slip saves with Ctrl+Enter; Cancel discards it, and Escape closes it only while empty", async () => {
    const itemId = unclipped()[0]!;
    const { page } = await open(`/items/${itemId}`);
    const slip = page.getByRole("group", { name: "Note on this clipping" });

    await dragAcross(page, 1, 20, 300);
    await page.getByRole("button", { name: "Add a note" }).click();
    await page.keyboard.type("Never mind.");
    await page.getByRole("button", { name: "Cancel" }).click();
    expect(await slip.isVisible()).toBe(false);
    expect(await page.evaluate(() => CSS.highlights.has("cp-pending"))).toBe(false);

    await dragAcross(page, 1, 20, 300);
    await page.getByRole("button", { name: "Add a note" }).click();
    await page.keyboard.type("Not this either.");
    // Escape doesn't throw away a note in progress.
    await page.keyboard.press("Escape");
    expect(await slip.isVisible()).toBe(true);
    expect(await page.locator("#clip-note").inputValue()).toBe("Not this either.");
    await page.locator("#clip-note").fill("");
    await page.keyboard.press("Escape");
    expect(await slip.isVisible()).toBe(false);
    expect(listAnnotations(library.db, ALICE, itemId)).toHaveLength(0);

    // A slip opened again starts empty.
    await dragAcross(page, 2, 20, 300);
    await page.getByRole("button", { name: "Add a note" }).click();
    expect(await page.locator("#clip-note").inputValue()).toBe("");
    await page.keyboard.type("Kept with the keyboard.");
    await page.keyboard.press("Control+Enter");
    await saved(page, "Clipped, with your note.");
    expect(listAnnotations(library.db, ALICE, itemId).map((clipping) => clipping.note)).toEqual(["Kept with the keyboard."]);
  });

  test("a clipping that can't be saved says why, keeps the note, and saves on a retry", async () => {
    const itemId = unclipped()[0]!;
    const { page } = await open(`/items/${itemId}`);
    const selected = await dragAcross(page, 1, 20, 300);
    await page.route(`**/items/${itemId}/clippings`, (route) => route.abort("internetdisconnected"));
    await page.getByRole("button", { name: "Clip it" }).click();
    const alert = page.getByRole("alert");
    await alert.waitFor();
    expect(await alert.textContent()).toContain("couldn't save the clipping");
    expect(await page.getByRole("group", { name: "Note on this clipping" }).isVisible()).toBe(true);
    await page.keyboard.type("Written while offline.");
    await page.getByRole("button", { name: "Save clipping" }).click();
    await page.waitForTimeout(200);
    expect(await page.locator("#clip-note").inputValue()).toBe("Written while offline.");
    expect(listAnnotations(library.db, ALICE, itemId)).toHaveLength(0);

    // A slow answer: the button says it is saving until the answer comes.
    await page.unroute(`**/items/${itemId}/clippings`);
    const answer = Promise.withResolvers<void>();
    await page.route(`**/items/${itemId}/clippings`, async (route) => {
      await answer.promise;
      await route.continue();
    });
    await page.getByRole("button", { name: "Save clipping" }).click();
    await page.getByRole("button", { name: "Saving…" }).waitFor();
    answer.resolve();
    await saved(page, "Clipped, with your note.");
    expect(await page.locator("[data-clip-slip] [data-clip-label]").textContent()).toBe("Save clipping");
    const [clipping] = listAnnotations(library.db, ALICE, itemId);
    expect(clipping?.quote).toBe(selected.trim());
    expect(clipping?.note).toBe("Written while offline.");
  });

  test("a note that is too long is refused with the server's reason", async () => {
    const itemId = unclipped()[0]!;
    const { page } = await open(`/items/${itemId}`);
    await dragAcross(page, 1, 20, 300);
    await page.getByRole("button", { name: "Add a note" }).click();
    // The field's own limit stops typing, so this sets the value directly.
    await page.locator("#clip-note").evaluate((field: HTMLTextAreaElement) => {
      field.value = "x".repeat(2_001);
    });
    await page.getByRole("button", { name: "Save clipping" }).click();
    await page.getByRole("alert").waitFor();
    expect(await page.getByRole("alert").textContent()).toContain("2000 characters");
    expect(listAnnotations(library.db, ALICE, itemId)).toHaveLength(0);
  });

  test("the pop-up leaves when the selection does, on Escape, and for text outside the article", async () => {
    const { page } = await open(`/items/${ids[4]!}`);
    await dragAcross(page, 1, 30, 200);
    expect(await popVisible(page)).toBe(true);
    await page.keyboard.press("Escape");
    expect(await popVisible(page)).toBe(false);

    await dragAcross(page, 1, 30, 200);
    await page.mouse.click(5, 300);
    await page.waitForTimeout(100);
    expect(await popVisible(page)).toBe(false);

    const title = (await page.locator("#reader-title").boundingBox())!;
    await page.mouse.move(title.x + 5, title.y + 20);
    await page.mouse.down();
    await page.mouse.move(title.x + 200, title.y + 20, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(350);
    expect(await popVisible(page)).toBe(false);
  });

  test("the structured view offers no clipping", async () => {
    const { page } = await open(`/items/${ids[5]!}/raw`);
    expect(await page.locator("[data-clip-pop], [data-clip-form]").count()).toBe(0);
    expect(await page.locator("script[src='/scripts/clip.js']").count()).toBe(0);
  });

  test("on a phone the reader fits, and its ribbon clears the links", async () => {
    const clipped = ids.at(-1)!;
    const { page, errors } = await open(`/items/${clipped}`, { viewport: PHONE, hasTouch: true });
    const layout = await page.evaluate(() => {
      const ribbon = document.querySelector(".ribbon")!.getBoundingClientRect();
      const links = [...document.querySelectorAll(".kicker a")].map((link) => link.getBoundingClientRect());
      return {
        overflow: document.documentElement.scrollWidth - innerWidth,
        overlaps: links.some((link) => link.right > ribbon.left && link.left < ribbon.right && link.bottom > ribbon.top && link.top < ribbon.bottom),
      };
    });
    expect(layout).toEqual({ overflow: 0, overlaps: false });
    expect(errors).toEqual([]);
  });
});
