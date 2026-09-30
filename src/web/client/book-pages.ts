// The arithmetic of the commonplace book: how many pages the clippings fill,
// which spread shows a page, and what a page turn carries. Pure, so it is
// tested without a browser; `book.ts` measures the page and applies it.

// A spread shows one page on a narrow window and two on a wide one.
export type PagesPerSpread = 1 | 2;

export type Direction = 1 | -1;

// The flow of clippings is laid out in columns of one page each. `extent` is
// how far its content runs from the flow's left edge; each column after the
// first adds a gap.
export function pageCount(extent: number, columnWidth: number, gap: number): number {
  if (columnWidth <= 0) return 1;
  return Math.max(1, Math.round((extent + gap) / (columnWidth + gap)));
}

export function spreadCount(pages: number, perSpread: PagesPerSpread): number {
  return Math.max(1, Math.ceil(pages / perSpread));
}

export function spreadOfPage(page: number, perSpread: PagesPerSpread): number {
  return Math.floor(Math.max(0, page) / perSpread);
}

// The page an element starts on, from its left edge within the flow.
export function pageAt(left: number, columnWidth: number, gap: number): number {
  return Math.max(0, Math.floor((left + gap / 2) / (columnWidth + gap)));
}

export function pageLabel(spread: number, perSpread: PagesPerSpread, pages: number): string {
  const first = spread * perSpread + 1;
  const last = Math.min(first + perSpread - 1, pages);
  return first === last ? `Page ${first} of ${pages}` : `Pages ${first}–${last} of ${pages}`;
}

export type LeafSide = "left" | "right" | "single";

// A page turn in pictures. The leaf is the paper that turns: `front` is the
// page it lifts and `back` the page it lands as, or `null` for a single page,
// whose back isn't seen. `under` is a copy of the page the leaf uncovers
// while the spread beneath already shows the new pages. A single page turned
// back lands on top of the current page, so the spread changes only after it
// lands: `settle` says when.
export type TurnPlan = {
  to: number;
  leaf: LeafSide;
  front: number;
  back: number | null;
  under: { page: number; side: "left" | "right" } | null;
  settle: "before" | "after";
};

export function turnPlan(at: number, direction: Direction, perSpread: PagesPerSpread, pages: number): TurnPlan | null {
  const to = at + direction;
  if (to < 0 || to >= spreadCount(pages, perSpread)) return null;
  if (perSpread === 1) {
    return direction === 1
      ? { to, leaf: "single", front: at, back: null, under: null, settle: "before" }
      : { to, leaf: "single", front: to, back: null, under: null, settle: "after" };
  }
  const current = at * perSpread;
  const next = to * perSpread;
  return direction === 1
    ? { to, leaf: "right", front: current + 1, back: next, under: { page: current, side: "left" }, settle: "before" }
    : { to, leaf: "left", front: current, back: next + 1, under: { page: current + 1, side: "right" }, settle: "before" };
}
