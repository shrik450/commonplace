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
import { fetchPage } from "./submit";

type Side = "newer" | "older";

// The box loads the next page of cards once fewer than this many loaded cards
// are left in the direction of travel.
const CARDS_BEFORE_LOADING = 40;

// Brings the index box to life: cards fold into the piles as they scroll past,
// the piles show how many cards lie behind and ahead, and a hovered or focused
// card is pulled up to show its details. Nearing either end of the loaded
// cards loads the next page of them. The script only measures and sets state;
// `box.css` draws every part of it.
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

  const status = box.querySelector("[data-box-status]");
  const stackCards = () => [...stack.children].filter((card): card is HTMLElement => card instanceof view.HTMLElement);
  let cards = stackCards();
  if (cards.length === 0) return;
  // How many cards lie beyond the loaded ones, at either end.
  let newerCount = Number(box.dataset.newerCount ?? 0);
  let olderCount = Number(box.dataset.olderCount ?? 0);

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
    stack.style.setProperty("--back-pile", String(backPile.offsetHeight));
    stack.style.setProperty("--front-pile", String(frontPile.offsetHeight));
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
    if (counts.ahead < CARDS_BEFORE_LOADING) void extend("older");
    if (counts.passed < CARDS_BEFORE_LOADING) void extend("newer");
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

  // Cards were added or removed, so every card's place in the stack is new.
  const restack = () => {
    for (const card of cards) {
      delete card.dataset.hidden;
      delete card.dataset.fold;
      card.style.removeProperty("--fold");
      card.style.removeProperty("--strip");
    }
    cards = stackCards();
    frame = { hiddenBefore: 0, hiddenFrom: cards.length - 1, folds: [] };
    relayout();
  };

  // Loads the next page of cards on one side and files them in the stack.
  // The page comes from the guide card's own link, so a box that can't load
  // it keeps the guide, which still leads there.
  let loading = false;
  const gaveUp = { newer: false, older: false };
  const extend = async (side: Side) => {
    const guide = stack.querySelector(`[data-guide="${side}"]`);
    const link = guide?.querySelector("a");
    if (loading || gaveUp[side] || guide === null || !(link instanceof view.HTMLAnchorElement)) return;
    loading = true;
    const answer = await fetchPage(view, link.href);
    loading = false;
    const page = answer.kind === "accepted" ? answer.page.querySelector("[data-index-box]") : null;
    const held = new Set(cards.map((card) => card.dataset.cursor));
    const fresh = page === null ? [] : [...page.querySelectorAll("[data-stack] > [data-card=item]")]
      .filter((card) => !held.has(card.getAttribute("data-cursor") ?? undefined))
      .map((card) => document.adoptNode(card));
    if (page === null || fresh.length === 0) {
      gaveUp[side] = true;
      return;
    }
    // The cards in view stay where they are while cards arrive behind them.
    // The guide is replaced, so the place is kept by a card that stays.
    const inView = cards.slice(frame.hiddenBefore).find((card) => card.dataset.card !== "guide");
    const top = inView?.offsetTop ?? 0;
    // A box opened part way through the library starts under its guide. Once
    // the newer cards replace the guide, its first card stands at the back
    // pile's edge, as the address says.
    const opening = side === "newer" && stack.scrollTop === 0;
    for (const card of [...fresh, ...stack.querySelectorAll("#end")]) card.removeAttribute("id");
    if (side === "older") guide.before(...fresh);
    else guide.after(...fresh);
    const nextGuide = page.querySelector(`[data-guide="${side}"]`);
    if (nextGuide === null) guide.remove();
    else guide.replaceWith(document.adoptNode(nextGuide));
    if (side === "older") olderCount = Number(page.getAttribute("data-older-count") ?? 0);
    else newerCount = Number(page.getAttribute("data-newer-count") ?? 0);
    restack();
    if (inView !== undefined && opening) {
      // The pile grows as cards go behind it, so its edge is read twice.
      for (let pass = 0; pass < 2; pass += 1) {
        stack.scrollTop = inView.offsetTop - backPile.offsetHeight;
        render();
      }
    } else if (inView !== undefined) {
      stack.scrollTop += inView.offsetTop - top;
    }
    if (status !== null) status.textContent = `${fresh.length} ${side} cards loaded.`;
    schedule();
  };

  // The address names the first card in view, so coming back to the library,
  // or reloading it, opens the box there.
  let addressed = 0;
  const address = () => {
    const behind = cards.slice(0, frame.hiddenBefore).findLast((card) => card.dataset.cursor !== undefined);
    const atStart = behind === undefined && stack.querySelector("[data-guide=newer]") === null;
    if (behind === undefined && !atStart) return;
    const path = behind === undefined ? "/library" : `/library?before=${encodeURIComponent(behind.dataset.cursor ?? "")}`;
    if (path !== view.location.pathname + view.location.search) view.history.replaceState(view.history.state, "", path);
  };

  // A pointer pull belongs to where the pointer rests, so scrolling drops it.
  // A keyboard pull follows the focused card, and `render` restores it.
  stack.addEventListener("scroll", () => {
    pull(null);
    schedule();
    view.clearTimeout(addressed);
    addressed = view.setTimeout(address, 250);
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
