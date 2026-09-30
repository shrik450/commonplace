import { describe, expect, test } from "bun:test";

import {
  boxFrame,
  MAX_SLIVERS,
  pileCounts,
  pileDepth,
  pullOffsets,
  stackLayout,
  type StackLayout,
} from "../../src/web/client/box-geometry";

// Ten cards, each showing a 50px strip, the frontmost 150px tall in full.
function evenStack(count = 10, strip = 50, lastHeight = 150): StackLayout {
  const tops = Array.from({ length: count }, (_, index) => index * strip);
  const heights = tops.map((_, index) => (index === count - 1 ? lastHeight : strip + 100));
  return stackLayout(tops, heights);
}

describe("stackLayout", () => {
  test("a strip runs to the next card's top, and the last shows in full", () => {
    const layout = stackLayout([0, 40, 100], [140, 150, 120]);
    expect(layout.strips).toEqual([40, 60, 120]);
  });

  test("a single card is all strip", () => {
    expect(stackLayout([12], [80]).strips).toEqual([80]);
  });
});

describe("pileCounts", () => {
  test("nothing is passed at the top, and cards below the window are ahead", () => {
    expect(pileCounts(evenStack(), { scrollTop: 0, height: 200 })).toEqual({ passed: 0, ahead: 6 });
  });

  test("a card goes into the back pile only once all but a sliver has passed", () => {
    const layout = evenStack();
    expect(pileCounts(layout, { scrollTop: 41, height: 200 }).passed).toBe(0);
    expect(pileCounts(layout, { scrollTop: 42, height: 200 }).passed).toBe(1);
    expect(pileCounts(layout, { scrollTop: 142, height: 200 }).passed).toBe(3);
  });

  test("at the end of the stack nothing is ahead", () => {
    expect(pileCounts(evenStack(), { scrollTop: 400, height: 200 }).ahead).toBe(0);
  });

  test("a window taller than the stack has no piles", () => {
    expect(pileCounts(evenStack(3), { scrollTop: 0, height: 2000 })).toEqual({ passed: 0, ahead: 0 });
  });

  test("an empty stack has no piles", () => {
    expect(pileCounts({ tops: [], strips: [] }, { scrollTop: 0, height: 100 })).toEqual({ passed: 0, ahead: 0 });
  });
});

describe("pileDepth", () => {
  test("no cards draw no slivers, and one card draws one", () => {
    expect(pileDepth(0)).toBe(0);
    expect(pileDepth(-3)).toBe(0);
    expect(pileDepth(1)).toBe(2);
  });

  test("depth grows ever more slowly, and stops at the maximum", () => {
    const depths = [1, 4, 9, 16, 25].map(pileDepth);
    for (let index = 1; index < depths.length; index += 1) expect(depths[index]!).toBeGreaterThanOrEqual(depths[index - 1]!);
    expect(pileDepth(25)).toBe(MAX_SLIVERS);
    expect(pileDepth(10_000)).toBe(MAX_SLIVERS);
  });
});

describe("boxFrame", () => {
  test("with no piles, nothing folds or hides", () => {
    const layout = evenStack();
    expect(boxFrame(layout, { scrollTop: 0, height: 300 }, { back: 0, front: 300 })).toEqual({
      hiddenBefore: 0,
      hiddenFrom: 9,
      folds: [],
    });
  });

  test("a card crossing the back pile's edge folds by how far it has crossed", () => {
    const layout = evenStack();
    const frame = boxFrame(layout, { scrollTop: 100, height: 300 }, { back: 20, front: 300 });
    expect(frame.hiddenBefore).toBe(2);
    expect(frame.folds).toEqual([{ index: 2, side: "back", progress: 0.4 }]);
  });

  test("cards wholly behind the back pile hide, and folding stays between 0 and 1", () => {
    const layout = evenStack();
    const frame = boxFrame(layout, { scrollTop: 300, height: 300 }, { back: 30, front: 300 });
    expect(frame.hiddenBefore).toBe(6);
    for (const fold of frame.folds) {
      expect(fold.progress).toBeGreaterThan(0);
      expect(fold.progress).toBeLessThanOrEqual(1);
    }
  });

  test("a card crossing the front pile's edge folds toward you, and those beyond hide", () => {
    const layout = evenStack();
    const frame = boxFrame(layout, { scrollTop: 0, height: 300 }, { back: 0, front: 270 });
    expect(frame.folds).toEqual([{ index: 5, side: "front", progress: 0.6 }]);
    expect(frame.hiddenFrom).toBe(6);
  });

  test("the frontmost card never folds or hides", () => {
    const layout = evenStack(3, 50, 400);
    const frame = boxFrame(layout, { scrollTop: 0, height: 120 }, { back: 0, front: 100 });
    expect(frame.folds.some((fold) => fold.index === 2)).toBe(false);
    expect(frame.hiddenFrom).toBeLessThanOrEqual(2);
  });

  test("a card is never both behind and ahead", () => {
    const layout = evenStack();
    for (let scrollTop = 0; scrollTop <= 400; scrollTop += 7) {
      const frame = boxFrame(layout, { scrollTop, height: 180 }, { back: 22, front: 150 });
      expect(frame.hiddenFrom).toBeGreaterThanOrEqual(frame.hiddenBefore);
      const indices = frame.folds.map((fold) => fold.index);
      expect(new Set(indices).size).toBe(indices.length);
      for (const index of indices) {
        expect(index).toBeGreaterThanOrEqual(frame.hiddenBefore);
        expect(index).toBeLessThan(frame.hiddenFrom + 1);
      }
    }
  });
});

describe("pullOffsets", () => {
  test("a card with room below stays put, and the cards in front drop the whole lift", () => {
    expect(pullOffsets(evenStack(), { scrollTop: 0, height: 400 }, 5, 88, { back: 0, front: 400 })).toEqual({ up: 0, down: 88 });
  });

  test("a card near the front pile drops what it can, and rises the rest", () => {
    expect(pullOffsets(evenStack(), { scrollTop: 0, height: 400 }, 5, 88, { back: 0, front: 360 })).toEqual({ up: 34, down: 54 });
  });

  test("a card already over the front pile's edge rises the whole lift", () => {
    expect(pullOffsets(evenStack(), { scrollTop: 0, height: 400 }, 7, 88, { back: 0, front: 360 })).toEqual({ up: 88, down: 0 });
  });

  test("the room below follows the scroll position", () => {
    expect(pullOffsets(evenStack(), { scrollTop: 100, height: 400 }, 7, 88, { back: 20, front: 360 })).toEqual({ up: 34, down: 54 });
  });
});
