import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Browser, Page } from "playwright-core";

import type { ItemId } from "../../src/contracts/ids";
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
