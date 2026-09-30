import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright-core";

import { DESKTOP, launch, PHONE, serve, visit, type Viewport } from "../test/support/browser";
import { seedDemo } from "../test/support/demo";
import { newRequestId } from "../src/contracts/ids";
import { listPageNotesForItems } from "../src/store/page-notes";
import { enqueueFetch } from "../src/store/queue";
import { ALICE, BOB, openLibrary, sessionCookie } from "../test/support/library";

// Renders every view of a demo library for a visual review.
//
//   bun run preview shots [filter]  screenshots into preview/shots
//   bun run preview serve [host]    serves the demo, signed in, on port 8411
//
// The demo library lives in preview/library and is rebuilt on every run.

const scrollStack = (to: number) => async (page: Page) => {
  await page.locator("[data-stack]").evaluate((stack, top) => {
    stack.scrollTop = top;
  }, to);
  await page.waitForTimeout(150);
};
// Scrolls to the oldest card. Nearing the end of the loaded cards loads more,
// so this scrolls again once they have arrived.
const scrollToEnd = async (page: Page) => {
  await scrollStack(100_000)(page);
  await page.waitForLoadState("networkidle");
  await scrollStack(100_000)(page);
};
// Moves the pointer onto the nth card clear of the back pile, counting from
// the front when negative. Locator hover would scroll the stack first, and
// scrolling drops a pull.
const hoverCard = async (page: Page, nth: number) => {
  const point = await page.locator("[data-stack]").evaluate((stack, index) => {
    const pile = stack.parentElement!.querySelector("[data-pile=back]")!.getBoundingClientRect();
    const clear = [...stack.children].filter((card) => card.getBoundingClientRect().top > pile.bottom);
    const box = clear.at(index)!.getBoundingClientRect();
    return { x: box.left + 80, y: box.top + 20 };
  }, nth);
  await page.mouse.move(point.x, point.y);
  await page.waitForTimeout(400);
};

const root = join(import.meta.dir, "..");
const out = join(root, "preview");
const [command = "shots", argument] = process.argv.slice(2);

await rm(join(out, "library"), { recursive: true, force: true });
const library = await openLibrary("preview", join(out, "library"));
const ids = await seedDemo(library, ALICE, 12);
const reader = ids.find((id) => id !== undefined)!;
const clipped = ids.at(-18)!;
// A page with a note and no clippings.
const noted = ids.at(-11)!;
const [pageNote] = listPageNotesForItems(library.db, ALICE, [clipped]);
// A save the preview never runs, so it waits at the front of the box.
const waiting = enqueueFetch(library.db, {
  id: newRequestId(),
  user_id: ALICE,
  item_id: null,
  url: "https://example.com/an-essay-saved-by-mistake",
  state: "queued",
  lease_expires_at: null,
  attempts: 0,
  error_code: null,
  created_at: library.clock.now.toISOString(),
});

if (command === "serve") {
  // Signs every request in as the demo reader, since the preview has no
  // identity provider.
  const cookie = sessionCookie(ALICE);
  const server = Bun.serve({
    port: 8411,
    hostname: argument ?? "127.0.0.1",
    fetch: (request) => {
      const headers = new Headers(request.headers);
      if (!headers.has("cookie")) headers.set("cookie", cookie);
      return library.app.handle(new Request(request, { headers }));
    },
  });
  console.log(`Serving the demo library at http://${server.hostname}:${server.port}/library`);
} else {
  const shots = join(out, "shots");
  await mkdir(shots, { recursive: true });
  const served = serve(library);
  const browser = await launch();
  type Shot = {
    name: string;
    path: string;
    viewport?: Viewport;
    scripts?: boolean;
    // Who is signed in: the demo reader unless named, or nobody.
    user?: typeof ALICE | null;
    // Gets the page into the state worth seeing, after it loads.
    act?: (page: Page) => Promise<void>;
    fullPage?: boolean;
  };
  const shotsToTake: Shot[] = [
    { name: "library", path: "/library" },
    { name: "library-scrolled", path: "/library", act: scrollStack(1400) },
    {
      name: "library-pulled",
      path: "/library",
      act: async (page) => {
        await scrollStack(1400)(page);
        await hoverCard(page, 3);
      },
    },
    {
      name: "library-pulled-top",
      path: "/library",
      act: async (page) => {
        await scrollStack(1400)(page);
        await hoverCard(page, 0);
      },
    },
    { name: "library-end", path: "/library", act: scrollToEnd },
    {
      name: "library-pulled-end",
      path: "/library",
      act: async (page) => {
        await scrollToEnd(page);
        await hoverCard(page, -2);
      },
    },
    { name: "library-empty", path: "/library", user: BOB },
    { name: "library-no-script", path: "/library", scripts: false },
    { name: "clippings", path: "/clippings" },
    {
      name: "clippings-turning",
      path: "/clippings",
      act: async (page) => {
        await page.getByRole("button", { name: "Next ›" }).click();
        await page.waitForTimeout(260);
        await page.locator(".leaf").evaluate((leaf) => leaf.getAnimations().forEach((animation) => animation.pause()));
      },
    },
    {
      name: "clippings-turned",
      path: "/clippings",
      act: async (page) => {
        await page.getByRole("button", { name: "Next ›" }).click();
        await page.waitForTimeout(900);
      },
    },
    {
      name: "clippings-note",
      path: `/clippings?item=${clipped}`,
      act: async (page) => {
        await page.locator("[data-note-edit]").first().click();
        await page.keyboard.type("Compare with the stream.");
        await page.waitForTimeout(300);
      },
    },
    { name: "clippings-no-script", path: "/clippings", scripts: false, fullPage: true },
    { name: "clippings-item", path: `/clippings?item=${clipped}` },
    { name: "clippings-page-note", path: `/clippings?item=${noted}` },
    {
      name: "clippings-page-note-editing",
      path: `/clippings?item=${noted}`,
      act: async (page) => {
        await page.locator("[data-page-note] [data-note-edit]").first().click();
        await page.waitForTimeout(300);
      },
    },
    { name: "reader", path: `/items/${clipped}`, fullPage: true },
    {
      name: "reader-selection",
      path: `/items/${reader}`,
      act: async (page) => {
        const paragraph = page.locator(".reader-text p").nth(1);
        const box = (await paragraph.boundingBox())!;
        await page.mouse.move(box.x + 40, box.y + 8);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width - 60, box.y + 8, { steps: 8 });
        await page.mouse.up();
        await page.waitForTimeout(200);
      },
    },
    {
      name: "reader-note",
      path: `/items/${reader}`,
      act: async (page) => {
        const paragraph = page.locator(".reader-text p").nth(1);
        const box = (await paragraph.boundingBox())!;
        await page.mouse.move(box.x + 40, box.y + 8);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width - 60, box.y + 8, { steps: 8 });
        await page.mouse.up();
        await page.waitForTimeout(200);
        await page.getByRole("button", { name: "Add a note" }).click();
        await page.keyboard.type("Compare with the stream.");
        await page.waitForTimeout(400);
      },
    },
    { name: "reader-structured", path: `/items/${clipped}/raw` },
    { name: "reader-page-notes", path: `/items/${clipped}#page-notes` },
    { name: "page-note", path: `/page-notes/${pageNote!.id}` },
    { name: "remove-page-note", path: `/page-notes/${pageNote!.id}/delete` },
    { name: "remove-page", path: `/items/${clipped}/delete` },
    { name: "save-status", path: `/saves/${waiting.id}` },
    { name: "remove-save", path: `/saves/${waiting.id}/delete` },
    { name: "search", path: "/search?q=memory", fullPage: true },
    { name: "search-empty", path: "/search" },
    { name: "settings", path: "/settings", fullPage: true },
    { name: "save", path: "/save" },
    {
      name: "save-card",
      path: "/library",
      act: async (page) => {
        await page.locator("[data-save-drop] summary").click();
        await page.waitForTimeout(300);
      },
    },
    { name: "error", path: "/saves/unknown" },
    { name: "home", path: "/", user: null },
  ];
  const filter = argument ?? "";
  for (const scheme of ["light", "dark"] as const) {
    for (const [size, viewport] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
      for (const shot of shotsToTake) {
        const name = `${shot.name}-${size}-${scheme}`;
        if (!name.includes(filter)) continue;
        // Phones can't hover to pull a card, and save on a page of their own.
        if (size === "phone" && (shot.name.includes("pulled") || shot.name === "save-card")) continue;
        const current = await visit(browser, served, shot.user === undefined ? ALICE : shot.user, {
          viewport: shot.viewport ?? viewport,
          scripts: shot.scripts ?? true,
          colorScheme: scheme,
          hasTouch: size === "phone",
        });
        await current.page.goto(`${served.origin}${shot.path}`, { waitUntil: "networkidle" });
        await current.page.evaluate(() => document.fonts.ready);
        await shot.act?.(current.page);
        await current.page.screenshot({ path: join(shots, `${name}.png`), fullPage: shot.fullPage ?? false });
        if (current.errors.length > 0) console.error(`${name}: ${current.errors.join("; ")}`);
        await current.close();
      }
    }
  }
  await browser.close();
  served.stop();
  await library.close();
  console.log(`Screenshots in ${shots}`);
}
