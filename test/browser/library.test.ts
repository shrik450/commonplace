import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Browser, Page } from "playwright-core";

import { DESKTOP, launch, PHONE, serve, visit, type Served, type Visit } from "../support/browser";
import { seedDemo } from "../support/demo";
import { ALICE, openLibrary, type TestLibrary } from "../support/library";

setDefaultTimeout(60_000);

let library: TestLibrary;
let served: Served;
let browser: Browser;
const visits: Visit[] = [];

beforeAll(async () => {
  library = await openLibrary("browser-library");
  await seedDemo(library, ALICE, 12);
  served = serve(library);
  browser = await launch();
});

afterAll(async () => {
  for (const current of visits) await current.close();
  await browser.close();
  served.stop();
  await library.close();
});

async function openBox(options: Parameters<typeof visit>[3] = {}, path = "/library"): Promise<Visit> {
  const current = await visit(browser, served, ALICE, options);
  visits.push(current);
  await current.page.goto(`${served.origin}${path}`, { waitUntil: "networkidle" });
  // With scripts off, the page's own promises and frames never run.
  if (options.scripts === false) await current.page.waitForTimeout(300);
  else await current.page.evaluate(() => document.fonts.ready);
  return current;
}

async function scrollStack(page: Page, top: number): Promise<void> {
  await page.locator("[data-stack]").evaluate((stack, value) => {
    stack.scrollTop = value;
  }, top);
  // Two frames: one for the scroll event, one for the render it schedules.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

type BoxState = {
  backPile: DOMRect;
  frontPile: DOMRect;
  stack: DOMRect;
  cards: { top: number; bottom: number; hidden: boolean; fold: string | null; progress: number; pulled: boolean }[];
};

async function boxState(page: Page): Promise<BoxState> {
  return page.evaluate(() => {
    const stack = document.querySelector("[data-stack]")!;
    return {
      backPile: document.querySelector("[data-pile=back]")!.getBoundingClientRect().toJSON(),
      frontPile: document.querySelector("[data-pile=front]")!.getBoundingClientRect().toJSON(),
      stack: stack.getBoundingClientRect().toJSON(),
      cards: [...stack.children].map((card) => {
        const box = card.getBoundingClientRect();
        return {
          top: box.top,
          bottom: box.bottom,
          hidden: card.hasAttribute("data-hidden"),
          fold: card.getAttribute("data-fold"),
          progress: Number(getComputedStyle(card).getPropertyValue("--fold") || 0),
          pulled: card.hasAttribute("data-pulled"),
        };
      }),
    };
  });
}

// The pointer position over the nth card whose top is clear of the back pile.
async function clearCardPoint(page: Page, nth: number): Promise<{ x: number; y: number; index: number }> {
  return page.evaluate((wanted) => {
    const stack = document.querySelector("[data-stack]")!;
    const pile = document.querySelector("[data-pile=back]")!.getBoundingClientRect();
    const cards = [...stack.children];
    const clear = cards.filter((card) => card.getBoundingClientRect().top > pile.bottom + 1 && !card.hasAttribute("data-fold"));
    const card = clear[wanted]!;
    const box = card.getBoundingClientRect();
    return { x: box.left + 60, y: box.top + 18, index: cards.indexOf(card) };
  }, nth);
}

// The slivers narrow with depth, so the corners of a pile's box are bare.
// Lists the cards found there.
function cardsInPileCorners(): string[] {
  const found: string[] = [];
  for (const side of ["back", "front"]) {
    const pile = document.querySelector(`[data-pile=${side}]`)!.getBoundingClientRect();
    if (pile.height < 12) continue;
    const y = side === "back" ? pile.top + 3 : pile.bottom - 3;
    for (const x of [pile.left + 2, pile.right - 2]) {
      const card = document.elementsFromPoint(x, y).find((element) => element.closest("[data-stack] > li") !== null);
      if (card !== undefined) found.push(`${side} pile at ${Math.round(x)},${Math.round(y)}`);
    }
  }
  return found;
}

describe("the index box", () => {
  test("fills the window: the page stays still and the stack scrolls", async () => {
    const { page, errors } = await openBox();
    const sizes = await page.evaluate(() => ({
      page: document.scrollingElement!.scrollHeight,
      window: innerHeight,
      stack: document.querySelector("[data-stack]")!.scrollHeight,
      stackBox: document.querySelector("[data-stack]")!.clientHeight,
      enhanced: document.querySelector("[data-index-box]")!.hasAttribute("data-enhanced"),
    }));
    expect(sizes.page).toBeLessThanOrEqual(sizes.window);
    expect(sizes.stack).toBeGreaterThan(sizes.stackBox);
    expect(sizes.enhanced).toBe(true);
    expect(errors).toEqual([]);
  });

  test("at the top, only cards ahead form a pile", async () => {
    const { page } = await openBox();
    const state = await boxState(page);
    expect(state.backPile.height).toBe(0);
    expect(state.frontPile.height).toBeGreaterThan(10);
    expect(state.cards.some((card) => card.hidden && card.top < state.frontPile.top)).toBe(false);
  });

  test("scrolled cards go into the back pile, and those crossing an edge fold", async () => {
    const { page, errors } = await openBox();
    for (const top of [300, 1400, 3200, 5100]) {
      await scrollStack(page, top);
      const state = await boxState(page);
      expect(state.backPile.height).toBeGreaterThan(10);
      for (const card of state.cards) {
        if (card.hidden) {
          // A hidden card is wholly behind a pile, or out of the window.
          const behindBack = card.top <= state.backPile.bottom + 1;
          const aheadOfFront = card.top >= state.frontPile.top - 1;
          expect(behindBack || aheadOfFront).toBe(true);
        }
        if (card.fold !== null) {
          expect(card.progress).toBeGreaterThan(0);
          expect(card.progress).toBeLessThanOrEqual(1);
          expect(card.hidden).toBe(false);
        }
      }
      // Every visible, unfolded card sits between the piles.
      for (const card of state.cards.filter((candidate) => !candidate.hidden && candidate.fold === null)) {
        if (card.top > state.stack.top && card.top < state.stack.bottom) {
          expect(card.top).toBeGreaterThanOrEqual(state.backPile.bottom - 1);
        }
      }
    }
    expect(errors).toEqual([]);
  });

  test("the back pile grows as you go deeper, within its limit", async () => {
    const { page } = await openBox();
    const heights: number[] = [];
    for (const top of [200, 1200, 4000, 100_000]) {
      await scrollStack(page, top);
      heights.push((await boxState(page)).backPile.height);
    }
    for (let index = 1; index < heights.length; index += 1) expect(heights[index]!).toBeGreaterThanOrEqual(heights[index - 1]!);
    expect(heights.at(-1)!).toBeLessThan(80);
  });

  test("tabbing reaches cards waiting in the front pile, and brings them into view", async () => {
    const { page } = await openBox();
    const ahead = await page.evaluate(() => {
      const cards = [...document.querySelectorAll("[data-stack] > li")];
      return cards.findIndex((card) => card.hasAttribute("data-hidden"));
    });
    expect(ahead).toBeGreaterThan(0);
    await page.locator(`[data-stack] > li:nth-child(${ahead}) a`).focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.waitForTimeout(300);
    const focused = await page.evaluate(() => {
      const card = document.activeElement!.closest("li")!;
      const stack = document.querySelector("[data-stack]")!.getBoundingClientRect();
      const box = card.getBoundingClientRect();
      return { hidden: card.hasAttribute("data-hidden"), inView: box.top >= stack.top && box.top < stack.bottom, opacity: getComputedStyle(card).opacity };
    });
    expect(focused).toEqual({ hidden: false, inView: true, opacity: "1" });
  });

  test("the frontmost card never goes into a pile", async () => {
    const { page } = await openBox();
    await scrollStack(page, 100_000);
    const state = await boxState(page);
    const last = state.cards.at(-1)!;
    expect(last.hidden).toBe(false);
    expect(last.fold).toBeNull();
    expect(last.bottom).toBeLessThanOrEqual(state.stack.bottom + 1);
  });

  test("hovering a card pulls it up to show its details, clear of the back pile", async () => {
    const { page } = await openBox();
    await scrollStack(page, 1400);
    for (const nth of [0, 4]) {
      // Let the previous pull drop and the cards settle before aiming.
      await page.mouse.move(5, 5);
      await page.waitForTimeout(400);
      const point = await clearCardPoint(page, nth);
      await page.mouse.move(point.x, point.y);
      await page.waitForTimeout(350);
      const pulled = await page.evaluate((index) => {
        const card = document.querySelector("[data-stack]")!.children[index]!;
        const pile = document.querySelector("[data-pile=back]")!.getBoundingClientRect();
        const details = card.querySelector(".card-meta")!.getBoundingClientRect();
        const next = card.nextElementSibling!.getBoundingClientRect();
        return {
          pulled: card.hasAttribute("data-pulled"),
          top: card.getBoundingClientRect().top,
          pileBottom: pile.bottom,
          detailsBottom: details.bottom,
          nextTop: next.top,
          excerpt: card.querySelector("[data-card-excerpt]")?.textContent ?? "",
        };
      }, point.index);
      expect(pulled.pulled).toBe(true);
      expect(pulled.top).toBeGreaterThanOrEqual(pulled.pileBottom);
      // The card in front has moved out of the way of the details.
      expect(pulled.nextTop).toBeGreaterThanOrEqual(pulled.detailsBottom);
      expect(pulled.excerpt.length).toBeGreaterThan(20);
    }
  });

  test("sweeping the pointer up or down the stack pulls every card in turn", async () => {
    const { page, errors } = await openBox({ reducedMotion: "reduce" });
    // The cards pulled as the pointer moves from `from` to `to`, one after
    // another, with repeats and gaps between cards left out.
    const sweep = async (from: number, to: number): Promise<number[]> => {
      const step = from < to ? 4 : -4;
      const x = (await page.locator("[data-stack]").boundingBox())!.x + 60;
      const pulled: number[] = [];
      for (let y = from; step > 0 ? y <= to : y >= to; y += step) {
        await page.mouse.move(x, y);
        await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
        const index = await page.evaluate(() => [...document.querySelector("[data-stack]")!.children].findIndex((card) => card.hasAttribute("data-pulled")));
        if (index !== -1 && index !== pulled.at(-1)) pulled.push(index);
      }
      return pulled;
    };

    // In the middle of the page, then at its end, where the front pile is
    // close below the last cards.
    for (const top of [1400, 100_000]) {
      await scrollStack(page, top);
      const { backPile, frontPile } = await boxState(page);
      const up = await sweep(frontPile.top - 4, backPile.bottom + 4);
      expect(up.length).toBeGreaterThan(5);
      expect({ top, up }).toEqual({ top, up: up.map((_, at) => up[0]! - at) });
      const down = await sweep(backPile.bottom + 4, frontPile.top - 4);
      expect(down.length).toBeGreaterThan(5);
      expect({ top, down }).toEqual({ top, down: down.map((_, at) => down[0]! + at) });
    }
    expect(errors).toEqual([]);
  });

  test("no card shows beside a pile's slivers, at rest or while a card is pulled", async () => {
    const { page } = await openBox({ reducedMotion: "reduce" });
    const cardsInCorners = async () => {
      await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
      return page.evaluate(cardsInPileCorners);
    };
    for (const top of [1400, 1412, 1425, 1440, 100_000]) {
      await scrollStack(page, top);
      expect({ top, cards: await cardsInCorners() }).toEqual({ top, cards: [] });
      const { backPile, frontPile } = await boxState(page);
      for (const y of [frontPile.top - 70, backPile.bottom + 30]) {
        await page.mouse.move(640, y);
        expect({ top, y, cards: await cardsInCorners() }).toEqual({ top, y, cards: [] });
      }
      await page.mouse.move(5, 5);
    }
  });

  test("a pulled card never pushes the card in front of it out of reach", async () => {
    const { page } = await openBox({ reducedMotion: "reduce" });
    // Whether the card in front of the pulled one can still be pointed at.
    const nextInReach = () => page.evaluate(() => {
      const pulled = document.querySelector("[data-stack] > [data-pulled]");
      const next = pulled?.nextElementSibling;
      if (pulled === null || next === null || next === undefined) return "nothing pulled";
      const box = next.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + 60, box.top + 14);
      return hit !== null && next.contains(hit) ? "in reach" : `covered: ${next.textContent?.slice(0, 30)}`;
    });
    for (const top of [1400, 100_000]) {
      await scrollStack(page, top);
      const { backPile, frontPile } = await boxState(page);
      for (let y = backPile.bottom + 20; y < frontPile.top - 4; y += 12) {
        await page.mouse.move(640, y);
        await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
        expect({ top, y, next: await nextInReach() }).toEqual({ top, y, next: expect.stringMatching(/^(in reach|nothing pulled)$/) });
      }
      await page.mouse.move(5, 5);
    }
    // At the end of a page, the guide to the next one stays on show.
    const lastItem = page.locator("[data-stack] > [data-card=item]").last();
    const title = (await lastItem.locator(".card-title").boundingBox())!;
    await page.mouse.move(title.x + 20, title.y + 8);
    await page.waitForFunction(() => document.querySelector("[data-stack] > [data-pulled]") !== null);
    await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
    expect(await nextInReach()).toBe("in reach");
    await page.getByRole("link", { name: "Older cards" }).click();
    await page.waitForURL(/\/library\?before=/);
  });

  test("scrolling drops a pointer pull, and leaving the stack does too", async () => {
    const { page } = await openBox();
    await scrollStack(page, 600);
    const point = await clearCardPoint(page, 2);
    await page.mouse.move(point.x, point.y);
    await page.waitForTimeout(100);
    expect((await boxState(page)).cards.some((card) => card.pulled)).toBe(true);
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(200);
    const afterScroll = await boxState(page);
    expect(afterScroll.cards.filter((card) => card.pulled).length).toBeLessThanOrEqual(1);
    await page.mouse.move(5, 5);
    await page.waitForTimeout(100);
    expect((await boxState(page)).cards.some((card) => card.pulled)).toBe(false);
  });

  test("keyboard focus pulls the focused card, and keeps it pulled as the stack scrolls to it", async () => {
    const { page } = await openBox();
    await page.locator("[data-stack]").focus();
    for (let step = 0; step < 6; step += 1) await page.keyboard.press("Tab");
    await page.waitForTimeout(400);
    const focused = await page.evaluate(() => {
      const card = document.activeElement?.closest("li");
      return { pulled: card?.hasAttribute("data-pulled") ?? false, inStack: card?.parentElement?.hasAttribute("data-stack") ?? false };
    });
    expect(focused).toEqual({ pulled: true, inStack: true });
    const outline = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
    expect(outline).toBe("solid");
  });

  test("guide cards page through the library, and a newer page lands at its end", async () => {
    const { page, errors } = await openBox();
    await scrollStack(page, 100_000);
    await page.getByRole("link", { name: "Older cards" }).click();
    await page.waitForLoadState("networkidle");
    expect(page.url()).toContain("/library?before=");
    expect(await page.locator("[data-stack] a[href^='/items/']").count()).toBe(28);
    const newer = await boxState(page);
    expect(newer.backPile.height).toBeGreaterThan(20);

    await page.getByRole("link", { name: "Newer cards" }).click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(200);
    expect(page.url()).toContain("/library?after=");
    const atEnd = await page.locator("[data-stack]").evaluate((stack) => stack.scrollHeight - stack.clientHeight - stack.scrollTop);
    expect(atEnd).toBeLessThan(4);
    expect(await page.locator("[data-stack] a[href^='/items/']").count()).toBe(200);
    expect(errors).toEqual([]);
  });

  test("without a script the stack still scrolls, and a hovered card shows its details", async () => {
    const { page } = await openBox({ scripts: false });
    expect(await page.locator("[data-index-box]").getAttribute("data-enhanced")).toBeNull();
    // Most of a card stands behind the one in front, so point at its title.
    const card = page.locator("[data-stack] > li").nth(3);
    const next = page.locator("[data-stack] > li").nth(4);
    const title = (await card.locator(".card-title").boundingBox())!;
    const before = { card: (await card.boundingBox())!.y, next: (await next.boundingBox())!.y };
    await page.mouse.move(title.x + 20, title.y + title.height / 2);
    await page.waitForTimeout(400);
    expect((await card.boundingBox())!.y).toBe(before.card);
    expect((await next.boundingBox())!.y).toBeGreaterThan(before.next + 40);
    await page.mouse.wheel(0, 800);
    await page.waitForTimeout(300);
    expect(await page.locator("[data-stack]").evaluate((stack) => stack.scrollTop)).toBeGreaterThan(700);
  });

  test("on a phone the box fits, cards show their site, and nothing overflows sideways", async () => {
    const { page, errors } = await openBox({ viewport: PHONE, hasTouch: true });
    const layout = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - innerWidth,
      host: getComputedStyle(document.querySelector(".card-host")!).display,
      box: document.querySelector("[data-index-box]")!.getBoundingClientRect().toJSON(),
    }));
    expect(layout.overflow).toBeLessThanOrEqual(0);
    expect(layout.host).toBe("block");
    expect(layout.box.right).toBeLessThanOrEqual(PHONE.width);
    await scrollStack(page, 2000);
    expect((await boxState(page)).backPile.height).toBeGreaterThan(10);
    expect(errors).toEqual([]);
  });

  test("resizing the window re-measures the box", async () => {
    const { page, errors } = await openBox();
    await scrollStack(page, 1400);
    await page.setViewportSize({ width: 900, height: 600 });
    await page.waitForTimeout(300);
    await scrollStack(page, 1500);
    const state = await boxState(page);
    expect(state.backPile.height).toBeGreaterThan(10);
    expect(state.cards.some((card) => card.fold !== null || card.hidden)).toBe(true);
    await page.setViewportSize(DESKTOP);
    expect(errors).toEqual([]);
  });
});
