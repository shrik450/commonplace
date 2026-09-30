import { describe, expect, test } from "bun:test";

import {
  pageAt,
  pageCount,
  pageLabel,
  spreadCount,
  spreadOfPage,
  turnPlan,
} from "../../src/web/client/book-pages";

describe("pageCount", () => {
  test("counts columns, each after the first adding a gap", () => {
    expect(pageCount(300, 300, 100)).toBe(1);
    expect(pageCount(700, 300, 100)).toBe(2);
    expect(pageCount(1500, 300, 100)).toBe(4);
  });

  test("rounds off a pixel of measuring error", () => {
    expect(pageCount(1499.4, 300, 100)).toBe(4);
    expect(pageCount(1500.6, 300, 100)).toBe(4);
  });

  test("an unmeasured book has one page", () => {
    expect(pageCount(0, 0, 0)).toBe(1);
    expect(pageCount(0, 300, 100)).toBe(1);
  });
});

describe("spreads", () => {
  test("two pages to a spread, and an odd last page gets a spread of its own", () => {
    expect(spreadCount(5, 2)).toBe(3);
    expect(spreadCount(4, 2)).toBe(2);
    expect(spreadCount(5, 1)).toBe(5);
    expect(spreadCount(0, 2)).toBe(1);
  });

  test("a page belongs to the spread that shows it", () => {
    expect(spreadOfPage(0, 2)).toBe(0);
    expect(spreadOfPage(3, 2)).toBe(1);
    expect(spreadOfPage(4, 2)).toBe(2);
    expect(spreadOfPage(3, 1)).toBe(3);
    expect(spreadOfPage(-2, 2)).toBe(0);
  });

  test("an element's left edge places it on its page", () => {
    expect(pageAt(0, 300, 100)).toBe(0);
    expect(pageAt(400, 300, 100)).toBe(1);
    expect(pageAt(399, 300, 100)).toBe(1);
    expect(pageAt(1200, 300, 100)).toBe(3);
  });

  test("the label names the pages showing", () => {
    expect(pageLabel(0, 2, 5)).toBe("Pages 1–2 of 5");
    expect(pageLabel(2, 2, 5)).toBe("Page 5 of 5");
    expect(pageLabel(3, 1, 5)).toBe("Page 4 of 5");
    expect(pageLabel(0, 2, 1)).toBe("Page 1 of 1");
  });
});

describe("turnPlan", () => {
  test("a turn past either end goes nowhere", () => {
    expect(turnPlan(0, -1, 2, 6)).toBeNull();
    expect(turnPlan(2, 1, 2, 6)).toBeNull();
    expect(turnPlan(0, 1, 2, 1)).toBeNull();
  });

  test("turning forward lifts the right page, which lands as the next left page", () => {
    expect(turnPlan(0, 1, 2, 6)).toEqual({
      to: 1,
      leaf: "right",
      front: 1,
      back: 2,
      under: { page: 0, side: "left" },
      settle: "before",
    });
  });

  test("turning back lifts the left page, which lands as the previous right page", () => {
    expect(turnPlan(2, -1, 2, 6)).toEqual({
      to: 1,
      leaf: "left",
      front: 4,
      back: 3,
      under: { page: 5, side: "right" },
      settle: "before",
    });
  });

  test("a single page turns away forward, and turns back over the current page", () => {
    expect(turnPlan(1, 1, 1, 3)).toEqual({ to: 2, leaf: "single", front: 1, back: null, under: null, settle: "before" });
    expect(turnPlan(1, -1, 1, 3)).toEqual({ to: 0, leaf: "single", front: 0, back: null, under: null, settle: "after" });
  });

  test("turning onto a last spread with one page lands on a blank back", () => {
    const plan = turnPlan(1, 1, 2, 5);
    expect(plan).toMatchObject({ to: 2, front: 3, back: 4 });
  });
});
