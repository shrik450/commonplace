// The arithmetic of the index box: which cards have gone into the piles, which
// are folding into them, and how far a pulled card can rise. Pure, so it is
// tested without a browser; `index-box.ts` measures the page and applies it.

// Where each card sits in the stack, measured once per layout. `tops` holds
// each card's top edge in pixels from the top of the stack's content, in
// order. `strips` holds how much of each card shows under the card in front
// of it; the frontmost card shows all of itself.
export type StackLayout = { tops: readonly number[]; strips: readonly number[] };

export type Viewport = { scrollTop: number; height: number };

// Where the piles begin, in pixels from the top of the viewport: the bottom of
// the back pile and the top of the front pile.
export type PileEdges = { back: number; front: number };

// A card counts as gone into a pile once all but this much of it has passed
// the viewport's edge.
export const EDGE_SLACK = 8;

// The most slivers a pile draws, however many cards it holds.
export const MAX_SLIVERS = 11;

// A card is hidden once it has folded this far past its pile's edge.
const HIDDEN_PAST = 1.02;

export function stackLayout(tops: readonly number[], heights: readonly number[]): StackLayout {
  const strips = tops.map((top, index) => {
    const next = tops[index + 1];
    return next === undefined ? heights[index]! : next - top;
  });
  return { tops, strips };
}

// The first index whose value is at least `target`, in a sorted list.
function firstAtLeast(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (values[mid]! < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

// Counts the cards scrolled past the top of the viewport and those still
// below its bottom.
export type PileCounts = { passed: number; ahead: number };

export function pileCounts(layout: StackLayout, viewport: Viewport): PileCounts {
  const { tops, strips } = layout;
  const top = viewport.scrollTop + EDGE_SLACK;
  let passed = 0;
  while (passed < tops.length && tops[passed]! + strips[passed]! <= top) passed += 1;
  const bottom = viewport.scrollTop + viewport.height - EDGE_SLACK;
  const ahead = tops.length - firstAtLeast(tops, bottom);
  return { passed, ahead: Math.min(ahead, tops.length - passed) };
}

// How many slivers draw a pile of `count` cards. Growth slows as a pile
// grows, so a thousand cards still fit on the wall.
export function pileDepth(count: number): number {
  if (count <= 0) return 0;
  return Math.min(MAX_SLIVERS, Math.max(1, Math.round(Math.sqrt(count) * 2.2)));
}

export type FoldSide = "back" | "front";

export type Fold = { index: number; side: FoldSide; progress: number };

// The state of every card for one scroll position. Cards before
// `hiddenBefore` have gone into the back pile. Cards from `hiddenFrom` up to,
// but not including, the frontmost card have gone into the front pile; the
// frontmost card has nothing in front of it to fold under, so it never goes.
// `folds` lists the cards part way into a pile, with how far each has folded
// from 0 to 1.
export type BoxFrame = { hiddenBefore: number; hiddenFrom: number; folds: Fold[] };

export function boxFrame(layout: StackLayout, viewport: Viewport, edges: PileEdges): BoxFrame {
  const { tops, strips } = layout;
  const last = tops.length - 1;
  const folds: Fold[] = [];
  const y = (index: number) => tops[index]! - viewport.scrollTop;

  let hiddenBefore = 0;
  if (edges.back > 0) {
    while (hiddenBefore < last && (edges.back - y(hiddenBefore)) / strips[hiddenBefore]! > HIDDEN_PAST) hiddenBefore += 1;
    for (let index = hiddenBefore; index <= last && y(index) < edges.back; index += 1) {
      folds.push({ index, side: "back", progress: Math.min(1, (edges.back - y(index)) / strips[index]!) });
    }
  }

  let hiddenFrom = Math.max(last, 0);
  if (edges.front < viewport.height) {
    const folding = new Set(folds.map((fold) => fold.index));
    let index = Math.max(firstAtLeast(tops, viewport.scrollTop + edges.front) - 1, hiddenBefore, 0);
    for (; index < last; index += 1) {
      const progress = (y(index) + strips[index]! - edges.front) / strips[index]!;
      if (progress <= 0 || folding.has(index)) continue;
      if (progress > HIDDEN_PAST) break;
      folds.push({ index, side: "front", progress: Math.min(1, progress) });
    }
    hiddenFrom = index;
  }
  return { hiddenBefore, hiddenFrom, folds };
}

// How far the cards in front of a pulled card drop to show its details, and
// how far the card and those behind it rise to make up the rest when the front
// pile leaves too little room below it. Dropping comes first: a card that stays
// put keeps the pointer on its title, and nothing covers the card behind it.
export type PullOffsets = { up: number; down: number };

export function pullOffsets(
  layout: StackLayout,
  viewport: Viewport,
  index: number,
  lift: number,
  edges: PileEdges,
): PullOffsets {
  const GAP = 6;
  const stripBottom = layout.tops[index]! + layout.strips[index]! - viewport.scrollTop;
  const room = edges.front - GAP - stripBottom;
  const down = Math.max(0, Math.min(lift, room));
  return { up: lift - down, down };
}
