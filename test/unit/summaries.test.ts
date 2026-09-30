import { describe, expect, test } from "bun:test";

import { formatCursor, parseCursor, parsePagePosition } from "../../src/contracts/cursor";
import { asItemId } from "../../src/contracts/ids";
import { EXCERPT_MAX_LENGTH, summarize } from "../../src/core/summarize";
import { sanitize } from "../../src/core/sanitize";
import { walk } from "../../src/core/walk";
import { cardDate, counted, readingMinutes, variantOf } from "../../src/web/views/format";

function summaryOf(body: string) {
  const { text, map } = walk(sanitize(`<html><body>${body}</body></html>`));
  return summarize(text, map);
}

const PROSE = "A sentence long enough to read as a paragraph of real prose, quoted on a library card.";

describe("summarize", () => {
  test("the excerpt is the first long content block, not the heading or a short line", () => {
    const summary = summaryOf(`<article><h1>A title</h1><p>Short.</p><p>${PROSE}</p><p>${PROSE}${PROSE}</p></article>`);
    // A block keeps the line break that ends it; a card collapses it.
    expect(summary.excerpt.trim()).toBe(PROSE);
  });

  test("text outside the article neither becomes the excerpt nor counts", () => {
    const inside = summaryOf(`<article><p>${PROSE.repeat(4)}</p></article>`);
    const withNav = summaryOf(`<nav><p>${"Navigation that runs long enough to look like prose to a naive rule. ".repeat(2)}</p></nav><article><p>${PROSE.repeat(4)}</p></article>`);
    expect(withNav.excerpt).toBe(inside.excerpt);
    expect(withNav.content_length).toBe(inside.content_length);
  });

  test("a long block is cut at the maximum", () => {
    const summary = summaryOf(`<article><p>${PROSE.repeat(20)}</p></article>`);
    expect(summary.excerpt).toHaveLength(EXCERPT_MAX_LENGTH);
  });

  test("lengths count whole characters, and the cut never splits one", () => {
    // Each emoji is two UTF-16 units, so a cut by units would land inside one.
    const summary = summaryOf(`<article><p>${"😀".repeat(EXCERPT_MAX_LENGTH + 25)}</p></article>`);
    expect([...summary.excerpt]).toHaveLength(EXCERPT_MAX_LENGTH);
    expect(summary.excerpt.isWellFormed()).toBe(true);
    expect(summary.excerpt).toBe("😀".repeat(EXCERPT_MAX_LENGTH));
    expect(summaryOf(`<article><p>${"😀".repeat(60)}</p></article>`).excerpt).toBe("");
    expect(summaryOf(`<article><p>${"😀".repeat(90)}</p></article>`).content_length).toBe(90);
  });

  test("a page with only short lines has no excerpt but still a length", () => {
    const summary = summaryOf("<article><p>One.</p><p>Two.</p></article>");
    expect(summary.excerpt).toBe("");
    expect(summary.content_length).toBeGreaterThan(0);
  });
});

describe("readingMinutes and counts", () => {
  test("never less than a minute, then about 1,300 characters a minute", () => {
    expect(readingMinutes(0)).toBe(1);
    expect(readingMinutes(900)).toBe(1);
    expect(readingMinutes(2_600)).toBe(2);
    expect(readingMinutes(13_000)).toBe(10);
  });

  test("counts read naturally", () => {
    expect(counted(1, "clipping", "clippings")).toBe("1 clipping");
    expect(counted(0, "clipping", "clippings")).toBe("0 clippings");
    expect(counted(1_234, "card", "cards")).toBe("1,234 cards");
  });

  test("a card's date omits the year only when it is this year", () => {
    const today = new Date("2026-09-29T12:00:00.000Z");
    expect(cardDate("2026-09-28T23:30:00.000Z", "en-GB", today)).toBe("28 Sept");
    expect(cardDate("2025-12-31T10:00:00.000Z", "en-GB", today)).toBe("31 Dec 2025");
    expect(cardDate("2026-03-04T10:00:00.000Z", "en-US", today)).toBe("Mar 4");
  });

  test("a variant is stable and in range", () => {
    for (const key of ["a", "b", "0191d3a2-0000-7000-8000-000000000000"]) {
      const variant = variantOf(key, 6);
      expect(variant).toBeGreaterThanOrEqual(0);
      expect(variant).toBeLessThan(6);
      expect(variantOf(key, 6)).toBe(variant);
    }
    const spread = new Set(Array.from({ length: 60 }, (_, index) => variantOf(`key-${index}`, 6)));
    expect(spread.size).toBe(6);
  });
});

describe("cursors", () => {
  const cursor = { created_at: "2026-09-28T10:11:12.345Z", id: asItemId("0191d3a2-0000-7000-8000-000000000000") };

  test("round-trip through a link", () => {
    expect(parseCursor(formatCursor(cursor))).toEqual(cursor);
    const params = new URLSearchParams({ before: formatCursor(cursor) });
    expect(parsePagePosition(new URLSearchParams(params.toString()))).toEqual({ kind: "before", cursor });
  });

  test("no cursor means the newest page", () => {
    expect(parsePagePosition(new URLSearchParams())).toEqual({ kind: "newest" });
    expect(parsePagePosition(new URLSearchParams({ after: formatCursor(cursor) }))).toEqual({ kind: "after", cursor });
  });

  test("malformed cursors are refused with the cursor error", () => {
    for (const token of [
      "",
      "nonsense",
      "2026-09-28_0191d3a2-0000-7000-8000-000000000000",
      "2026-13-45T10:11:12.345Z_0191d3a2-0000-7000-8000-000000000000",
      "2026-09-28T10:11:12.345Z_not-an-id",
      "2026-09-28T10:11:12.345Z_0191D3A2-0000-7000-8000-000000000000",
    ]) {
      expect(() => parseCursor(token)).toThrow(expect.objectContaining({ code: "VIEW_INVALID_CURSOR" }));
    }
    expect(() => parsePagePosition(new URLSearchParams({ before: formatCursor(cursor), after: formatCursor(cursor) })))
      .toThrow(expect.objectContaining({ code: "VIEW_INVALID_CURSOR" }));
  });
});
