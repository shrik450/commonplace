import {
  boxFrame,
  pileCounts,
  pileDepth,
  pullOffsets,
  stackLayout,
  type BoxFrame,
  type PileEdges,
  type StackLayout,
  type Viewport,
} from "./box-geometry";

// Brings the index box to life: cards fold into the piles as they scroll past,
// the piles show how many cards lie behind and ahead, and a hovered or focused
// card is pulled up to show its details. The script only measures and sets
// state; `box.css` draws every part of it.
export function enhanceIndexBox(document: Document): void {
  const view = document.defaultView;
  const box = document.querySelector("[data-index-box]");
  const stack = box?.querySelector("[data-stack]");
  const backPile = box?.querySelector("[data-pile=back]");
  const frontPile = box?.querySelector("[data-pile=front]");
  if (
    view === null ||
    !(box instanceof view.HTMLElement) ||
    !(stack instanceof view.HTMLElement) ||
    !(backPile instanceof view.HTMLElement) ||
    !(frontPile instanceof view.HTMLElement)
  ) return;

  const cards = [...stack.children].filter((card): card is HTMLElement => card instanceof view.HTMLElement);
  if (cards.length === 0) return;
  const newerCount = Number(box.dataset.newerCount ?? 0);
  const olderCount = Number(box.dataset.olderCount ?? 0);

  let layout: StackLayout = { tops: [], strips: [] };
  let shown = { back: -1, front: -1 };
  let frame: BoxFrame = { hiddenBefore: 0, hiddenFrom: cards.length - 1, folds: [] };
  let pulled: HTMLElement | null = null;
  let scheduled = false;

  const viewport = (): Viewport => ({ scrollTop: stack.scrollTop, height: stack.clientHeight });
  const pileEdges = (): PileEdges => ({ back: backPile.offsetHeight, front: stack.clientHeight - frontPile.offsetHeight });

  const showPiles = (back: number, front: number) => {
    if (back === shown.back && front === shown.front) return;
    backPile.style.setProperty("--shown", String(back));
    frontPile.style.setProperty("--shown", String(front));
    shown = { back, front };
  };

  // The piles at either end of the page never change height, so the stack
  // leaves room for them once and scrolling never moves its content.
  const measure = () => {
    showPiles(pileDepth(newerCount), 0);
    const head = backPile.offsetHeight;
    showPiles(0, pileDepth(olderCount));
    const tail = frontPile.offsetHeight;
    stack.style.setProperty("--head", String(head));
    stack.style.setProperty("--tail", String(tail));
    layout = stackLayout(
      cards.map((card) => card.offsetTop),
      cards.map((card) => card.offsetHeight),
    );
  };

  const setHidden = (index: number, hidden: boolean) => {
    const card = cards[index]!;
    if (hidden) card.dataset.hidden = "";
    else delete card.dataset.hidden;
  };

  const apply = (next: BoxFrame) => {
    const previous = frame;
    const low = Math.min(previous.hiddenBefore, next.hiddenBefore);
    const high = Math.max(previous.hiddenBefore, next.hiddenBefore);
    for (let index = low; index < high; index += 1) setHidden(index, index < next.hiddenBefore);
    const from = Math.min(previous.hiddenFrom, next.hiddenFrom);
    const to = Math.max(previous.hiddenFrom, next.hiddenFrom);
    for (let index = from; index < to && index < cards.length - 1; index += 1) setHidden(index, index >= next.hiddenFrom);

    const folding = new Set(next.folds.map((fold) => fold.index));
    for (const fold of previous.folds) {
      if (folding.has(fold.index)) continue;
      const card = cards[fold.index]!;
      delete card.dataset.fold;
      card.style.removeProperty("--fold");
      card.style.removeProperty("--strip");
    }
    for (const fold of next.folds) {
      const card = cards[fold.index]!;
      card.dataset.fold = fold.side;
      card.style.setProperty("--fold", fold.progress.toFixed(3));
      card.style.setProperty("--strip", String(layout.strips[fold.index]));
    }
    frame = next;
  };

  const pull = (card: HTMLElement | null) => {
    if (card === pulled) return;
    if (pulled !== null) delete pulled.dataset.pulled;
    delete stack.dataset.rising;
    pulled = null;
    if (card === null || card.dataset.fold !== undefined || card.dataset.card === "guide") return;
    const index = cards.indexOf(card);
    if (index === -1 || index === cards.length - 1) return;
    const lift = Number.parseFloat(view.getComputedStyle(card).getPropertyValue("--lift"));
    if (!Number.isFinite(lift)) return;
    const { up, down } = pullOffsets(layout, viewport(), index, lift, pileEdges());
    stack.style.setProperty("--up", String(up));
    stack.style.setProperty("--down", String(down));
    if (up > 0) stack.dataset.rising = "";
    card.dataset.pulled = "";
    pulled = card;
  };

  const focusedCard = (): HTMLElement | null => {
    const active = document.activeElement;
    if (!(active instanceof view.HTMLElement) || !stack.contains(active) || !active.matches(":focus-visible")) return null;
    const card = active.closest("li");
    return card instanceof view.HTMLElement ? card : null;
  };

  const render = () => {
    scheduled = false;
    const current = viewport();
    const counts = pileCounts(layout, current);
    showPiles(pileDepth(newerCount + counts.passed), pileDepth(counts.ahead + olderCount));
    apply(boxFrame(layout, current, pileEdges()));
    const focused = focusedCard();
    if (focused !== null && focused !== pulled) pull(focused);
  };

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    view.requestAnimationFrame(render);
  };

  const relayout = () => {
    pull(null);
    measure();
    shown = { back: -1, front: -1 };
    render();
  };

  // A pointer pull belongs to where the pointer rests, so scrolling drops it.
  // A keyboard pull follows the focused card, and `render` restores it.
  stack.addEventListener("scroll", () => {
    pull(null);
    schedule();
  }, { passive: true });
  if (view.matchMedia("(hover: hover)").matches) {
    stack.addEventListener("pointerover", (event) => {
      const card = event.target instanceof view.Element ? event.target.closest("li") : null;
      pull(card instanceof view.HTMLElement && stack.contains(card) ? card : null);
    });
    stack.addEventListener("pointerleave", () => pull(null));
  }
  stack.addEventListener("focusin", () => {
    const card = focusedCard();
    if (card !== null) pull(card);
  });
  stack.addEventListener("focusout", () => pull(null));
  new view.ResizeObserver(relayout).observe(stack);
  void document.fonts.ready.then(relayout);

  box.dataset.enhanced = "";
  relayout();
  // A link to the end of a page, such as "Newer cards", lands on its last card.
  if (view.location.hash === "#end") stack.scrollTop = stack.scrollHeight;
}

if ("document" in globalThis) enhanceIndexBox(globalThis.document);
