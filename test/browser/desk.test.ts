import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Browser, Page } from "playwright-core";

import type { ItemId } from "../../src/contracts/ids";
import { listAnnotations } from "../../src/store/annotations";
import { DESKTOP, launch, PHONE, serve, visit, type Served, type Visit, type VisitOptions } from "../support/browser";
import { seedDemo } from "../support/demo";
import { ALICE, BOB, openLibrary, postForm, type TestLibrary } from "../support/library";

setDefaultTimeout(120_000);

let library: TestLibrary;
let served: Served;
let browser: Browser;
let ids: ItemId[];
const visits: Visit[] = [];

beforeAll(async () => {
  library = await openLibrary("browser-desk");
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

async function open(path: string, options: VisitOptions = {}, user: typeof ALICE | null = ALICE): Promise<Visit> {
  const current = await visit(browser, served, user, options);
  visits.push(current);
  await current.page.goto(`${served.origin}${path}`, { waitUntil: "networkidle" });
  if (options.scripts !== false) await current.page.evaluate(() => document.fonts.ready);
  return current;
}

async function setTheme(theme: "auto" | "light" | "dark", textWidth = "68"): Promise<void> {
  const response = await postForm(library, "/settings", {
    theme,
    font: "newsreader",
    text_size: "18",
    line_spacing: "170",
    paragraph_spacing: "90",
    text_width: textWidth,
  });
  expect(response.status).toBe(303);
}

// Problems a reader would notice on any page: script errors, sideways
// scrolling, controls with no name, and images with no text alternative.
async function pageProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    if (document.documentElement.scrollWidth > innerWidth) problems.push(`overflows sideways by ${document.documentElement.scrollWidth - innerWidth}px`);
    for (const control of document.querySelectorAll("input:not([type=hidden]), select, textarea, button, a[href]")) {
      if (!(control instanceof HTMLElement)) continue;
      const element = control;
      if (element.closest("[aria-hidden=true]") || !element.checkVisibility()) continue;
      const id = element.id;
      const named = element.getAttribute("aria-label") ||
        (id !== "" && document.querySelector(`label[for="${id}"]`)) ||
        element.closest("label") ||
        element.innerText.trim() ||
        [...element.querySelectorAll("img[alt]")].some((image) => image.getAttribute("alt") !== "") ||
        element.getAttribute("title");
      if (!named) problems.push(`unnamed ${element.tagName.toLowerCase()} ${element.outerHTML.slice(0, 80)}`);
    }
    for (const image of document.querySelectorAll("img")) {
      if (!image.hasAttribute("alt")) problems.push(`image without alt ${image.src}`);
    }
    return problems;
  });
}

describe("the desk around every page", () => {
  test("every page, in both themes and on both sizes, loads cleanly", async () => {
    const clipping = listAnnotations(library.db, ALICE, ids.at(-1)!)[0]!;
    const paths = [
      "/library",
      "/clippings",
      "/clippings?notes=1",
      `/items/${ids[0]}`,
      `/items/${ids[0]}/raw`,
      "/search?q=memory",
      "/search?q=zeppelin",
      "/search",
      "/settings",
      "/save",
      `/clippings/${clipping.id}`,
      `/clippings/${clipping.id}/delete`,
    ];
    for (const colorScheme of ["light", "dark"] as const) {
      for (const [viewport, hasTouch] of [[DESKTOP, false], [PHONE, true]] as const) {
        for (const path of paths) {
          const current = await open(path, { colorScheme, viewport, hasTouch });
          expect({ path, problems: await pageProblems(current.page), errors: current.errors }).toEqual({ path, problems: [], errors: [] });
          await current.close();
        }
      }
    }
    const home = await open("/", {}, null);
    expect(await pageProblems(home.page)).toEqual([]);
    expect(await home.page.getByRole("link", { name: "Sign in" }).isVisible()).toBe(true);
  });

  test("the box, the reader's sheet, and search share one width that follows the reading measure", async () => {
    const widths = async () => {
      const measure = async (path: string, selector: string) => {
        const current = await open(path);
        const width = (await current.page.locator(selector).first().boundingBox())!.width;
        await current.close();
        return Math.round(width);
      };
      return [
        await measure("/library", "[data-index-box]"),
        await measure(`/items/${ids[0]}`, ".reader-sheet"),
        await measure("/search?q=memory", ".catalogue"),
        await measure("/save", ".sheet"),
      ];
    };
    const normal = await widths();
    expect(new Set(normal.slice(0, 3)).size).toBe(1);
    await setTheme("auto", "84");
    const wide = await widths();
    await setTheme("auto", "68");
    expect(new Set(wide.slice(0, 3)).size).toBe(1);
    expect(wide[0]!).toBeGreaterThan(normal[0]! + 80);
    // The reader's text fills its sheet's measure.
    const current = await open(`/items/${ids[0]}`);
    const text = await current.page.evaluate(() => {
      const sheet = document.querySelector(".reader-sheet")!;
      const styles = getComputedStyle(sheet);
      const inner = sheet.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight);
      const column = document.querySelector(".reader-text")!.getBoundingClientRect().width;
      return { inner: Math.round(inner), column: Math.round(column) };
    });
    expect(Math.abs(text.inner - text.column)).toBeLessThanOrEqual(2);
  });

  test("the ink theme is the dark desk, chosen or followed from the system", async () => {
    await setTheme("dark");
    const chosen = await open("/library");
    const dark = await chosen.page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      scheme: getComputedStyle(document.documentElement).colorScheme,
      desk: getComputedStyle(document.documentElement).backgroundColor,
    }));
    expect(dark).toEqual({ theme: "ink", scheme: "dark", desk: "rgb(20, 21, 26)" });
    await setTheme("light");
    const light = await open("/library", { colorScheme: "dark" });
    expect(await light.page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe("rgb(239, 231, 216)");
    await setTheme("auto");
    const followed = await open("/library", { colorScheme: "dark" });
    expect(await followed.page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe("rgb(20, 21, 26)");
  });

  test("the save card drops open, takes focus, and closes on Escape or a click away", async () => {
    const { page, errors } = await open("/library");
    const summary = page.locator("[data-save-drop] summary");
    await summary.click();
    expect(await page.locator("[data-save-drop]").getAttribute("open")).toBe("");
    // The card takes focus when it has finished opening.
    await page.waitForFunction(() => document.activeElement?.id === "save-drop-url");
    await page.keyboard.press("Escape");
    expect(await page.locator("[data-save-drop]").getAttribute("open")).toBeNull();
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("SUMMARY");
    await summary.click();
    await page.mouse.click(40, 600);
    expect(await page.locator("[data-save-drop]").getAttribute("open")).toBeNull();

    await summary.click();
    await page.waitForFunction(() => document.activeElement?.id === "save-drop-url");
    await page.keyboard.type("https://example.com/a-new-essay");
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/saves\/[0-9a-f-]+$/);
    expect(await page.locator("h1").textContent()).toBe("Waiting to save…");
    expect(errors).toEqual([]);
  });

  test("the save card works without a script, and phones save on a page of their own", async () => {
    const plain = await open("/library", { scripts: false });
    await plain.page.locator("[data-save-drop] summary").click();
    expect(await plain.page.locator("#save-drop-url").isVisible()).toBe(true);

    const phone = await open("/library", { viewport: PHONE, hasTouch: true });
    expect(await phone.page.locator("[data-save-drop]").isVisible()).toBe(false);
    await phone.page.getByRole("link", { name: "Save", exact: true }).click();
    await phone.page.waitForLoadState("networkidle");
    expect(phone.page.url()).toBe(`${served.origin}/save`);
    await phone.page.getByLabel("Link").fill("https://example.com/from-a-phone");
    await phone.page.getByRole("button", { name: "Save page" }).click();
    await phone.page.waitForURL(/\/saves\//);
  });

  test("on a phone, search and settings are icons that lead to their pages", async () => {
    const { page } = await open("/library", { viewport: PHONE, hasTouch: true });
    expect(await page.locator("header .search-slip").isVisible()).toBe(false);
    await page.getByRole("link", { name: "Search your library" }).click();
    await page.waitForLoadState("networkidle");
    const field = page.locator("main input[name=q]");
    expect(await field.isVisible()).toBe(true);
    await field.fill("index");
    await field.press("Enter");
    await page.waitForLoadState("networkidle");
    expect(await page.locator("[data-stamp]").textContent()).toMatch(/found$/);
    await page.getByRole("link", { name: "Settings" }).click();
    await page.waitForLoadState("networkidle");
    expect(page.url()).toBe(`${served.origin}/settings`);
  });

  test("settings preview live and save without leaving the page", async () => {
    const { page, errors } = await open("/settings");
    await page.getByLabel("Theme").selectOption("dark");
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("dark");
    await page.locator("#text_width").fill("80");
    expect(await page.locator("#text_width-value").textContent()).toBe("80 ch");
    await page.getByRole("button", { name: "Save settings" }).click();
    await page.waitForFunction(() => document.querySelector("[data-cp-settings-status]")?.textContent === "Settings saved.");
    expect(page.url()).toBe(`${served.origin}/settings`);
    await page.reload({ waitUntil: "networkidle" });
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("ink");
    expect(await page.locator("#text_width").inputValue()).toBe("80");
    await setTheme("auto");
    expect(errors).toEqual([]);
  });

  test("the skip link appears for the keyboard and moves past the bar", async () => {
    const { page } = await open("/search?q=memory");
    await page.keyboard.press("Tab");
    const link = page.getByRole("link", { name: "Skip to main content" });
    const box = (await link.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    await page.keyboard.press("Enter");
    expect(page.url()).toContain("#main");
  });

  test("an empty library invites the first save", async () => {
    const { page, errors } = await open("/library", {}, BOB);
    expect(await page.getByText("Your library is empty.").isVisible()).toBe(true);
    await page.getByLabel("Address of the page to save").fill("https://example.com/first");
    await page.locator("[data-stack] button[type=submit]").click();
    await page.waitForURL(/\/saves\//);
    await page.goto(`${served.origin}/library`, { waitUntil: "networkidle" });
    expect(await page.locator("[data-card=save]").count()).toBe(1);
    expect(errors).toEqual([]);
  });
});
