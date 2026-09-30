import {
  pageAt,
  pageCount,
  pageLabel,
  spreadCount,
  spreadOfPage,
  turnPlan,
  type Direction,
  type PagesPerSpread,
  type TurnPlan,
} from "./book-pages";

type Metrics = { perSpread: PagesPerSpread; column: number; gap: number; flowWidth: number; pages: number };

type Turning = { leaf: HTMLElement; under: HTMLElement | null; plan: TurnPlan };

// Paginates the commonplace book and turns its pages. Without this script the
// clippings read as one scrolling page. The script only measures and sets
// state; `book.css` lays out the columns and draws the turning leaf.
export function enhanceBook(document: Document): void {
  const view = document.defaultView;
  const book = document.querySelector("[data-book]");
  const spread = book?.querySelector("[data-spread]");
  const flow = book?.querySelector("[data-flow]");
  if (view === null || !(book instanceof view.HTMLElement) || !(spread instanceof view.HTMLElement) || !(flow instanceof view.HTMLElement)) return;

  const turnButtons = [...book.querySelectorAll("[data-turn]")].filter((button) => button instanceof view.HTMLButtonElement);
  const turnBar = book.querySelector("[data-turns]");
  const count = book.querySelector("[data-page-count]");
  const folios = {
    left: book.querySelector("[data-folio=left]"),
    right: book.querySelector("[data-folio=right]"),
  };
  const reducedMotion = view.matchMedia("(prefers-reduced-motion: reduce)");

  let metrics: Metrics = { perSpread: 2, column: 0, gap: 0, flowWidth: 0, pages: 1 };
  let at = 0;
  let turning: Turning | null = null;

  const measure = (): Metrics => {
    const perSpread: PagesPerSpread = view.getComputedStyle(spread).getPropertyValue("--pages").trim() === "1" ? 1 : 2;
    const gap = Number.parseFloat(view.getComputedStyle(flow).columnGap) || 0;
    const flowWidth = flow.clientWidth;
    const column = (flowWidth - (perSpread - 1) * gap) / perSpread;
    spread.style.setProperty("--flow-width", String(flowWidth));
    spread.style.setProperty("--column", String(column));
    spread.style.setProperty("--gap", String(gap));
    // `scrollWidth` undercounts a multi-column element's overflow columns, so
    // measure how far the flow's content actually runs.
    const flowLeft = flow.getBoundingClientRect().left;
    let extent = 0;
    for (const child of flow.children) {
      for (const rect of child.getClientRects()) extent = Math.max(extent, rect.right - flowLeft);
    }
    return { perSpread, column, gap, flowWidth, pages: pageCount(extent, column, gap) };
  };

  const show = () => {
    const { perSpread, pages } = metrics;
    at = Math.min(at, spreadCount(pages, perSpread) - 1);
    spread.style.setProperty("--spread-index", String(at));
    const first = at * perSpread;
    if (folios.left !== null) folios.left.textContent = String(first + 1);
    if (folios.right !== null) folios.right.textContent = perSpread === 2 && first + 1 < pages ? String(first + 2) : "";
    if (count !== null) count.textContent = pageLabel(at, perSpread, pages);
    for (const button of turnButtons) {
      const direction = Number(button.dataset.turn);
      button.disabled = direction < 0 ? at === 0 : at >= spreadCount(pages, perSpread) - 1;
    }
    remember();
  };

  // A copy of the flow, shifted so one page shows through a page-sized window.
  const face = (page: number, side: string, role: string): HTMLElement => {
    const sheet = document.createElement("div");
    sheet.className = "leaf-face";
    sheet.dataset.side = side;
    sheet.dataset.role = role;
    sheet.setAttribute("aria-hidden", "true");
    const pageWindow = document.createElement("div");
    pageWindow.className = "leaf-window";
    const copy = flow.cloneNode(true);
    if (copy instanceof view.HTMLElement) {
      copy.removeAttribute("data-flow");
      for (const element of [copy, ...copy.querySelectorAll("[id]")]) element.removeAttribute("id");
      copy.style.setProperty("--page", String(page));
      pageWindow.append(copy);
    }
    sheet.append(pageWindow);
    if (page < metrics.pages) {
      const folio = document.createElement("span");
      folio.className = "folio";
      folio.dataset.folio = side === "single" ? "left" : side;
      folio.textContent = String(page + 1);
      sheet.append(folio);
    }
    return sheet;
  };

  const finish = () => {
    if (turning === null) return;
    const { leaf, under, plan } = turning;
    turning = null;
    leaf.remove();
    under?.remove();
    if (plan.settle === "after") {
      at = plan.to;
      show();
    }
  };

  const turn = (direction: Direction) => {
    finish();
    const plan = turnPlan(at, direction, metrics.perSpread, metrics.pages);
    if (plan === null) return;
    if (reducedMotion.matches) {
      at = plan.to;
      show();
      return;
    }
    const leaf = document.createElement("div");
    leaf.className = "leaf";
    leaf.dataset.leaf = plan.leaf;
    leaf.dataset.direction = String(direction);
    const frontSide = plan.leaf;
    const backSide = plan.leaf === "right" ? "left" : "right";
    leaf.append(face(plan.front, frontSide, "front"));
    if (plan.back !== null) leaf.append(face(plan.back, backSide, "back"));
    const under = plan.under === null ? null : face(plan.under.page, plan.under.side, "under");
    if (under !== null) spread.append(under);
    spread.append(leaf);
    turning = { leaf, under, plan };
    leaf.addEventListener("animationend", finish, { once: true });
    if (plan.settle === "before") {
      at = plan.to;
      show();
    }
  };

  // The page an element of the flow starts on, in the current layout.
  const pageOf = (element: Element): number =>
    pageAt(element.getBoundingClientRect().left - flow.getBoundingClientRect().left, metrics.column, metrics.gap);

  // What the reader is looking at: the first title or clipping on the
  // spread. Recorded on every page change, because by the time a resize is
  // observed the clippings have already reflowed.
  let reading: Element | null = null;
  const remember = () => {
    const firstPage = at * metrics.perSpread;
    reading = [...flow.querySelectorAll(".title-page, .locus-head, .clipping")].find((element) => pageOf(element) >= firstPage) ?? null;
  };

  // A new window size reflows the clippings into different pages, so the
  // book reopens where the passage being read now falls.
  const relayout = () => {
    finish();
    metrics = measure();
    at = reading === null ? 0 : spreadOfPage(pageOf(reading), metrics.perSpread);
    show();
  };

  const openAt = (hash: string) => {
    if (!hash.startsWith("#item-")) return;
    const target = flow.querySelector(`#${view.CSS.escape(hash.slice(1))}`);
    if (target === null) return;
    at = spreadOfPage(pageOf(target), metrics.perSpread);
    show();
  };

  // A link on a page that isn't showing can still take focus from the
  // keyboard. The browser would scroll the page window to reveal it, which
  // the book never does, so instead the book opens at that page.
  const pageWindow = flow.parentElement;
  flow.addEventListener("focusin", (event) => {
    if (pageWindow !== null) pageWindow.scrollLeft = 0;
    if (!(event.target instanceof view.Element)) return;
    const holding = spreadOfPage(pageOf(event.target), metrics.perSpread);
    if (holding === at) return;
    finish();
    at = holding;
    show();
  });
  pageWindow?.addEventListener("scroll", () => {
    pageWindow.scrollLeft = 0;
  });

  for (const button of turnButtons) {
    button.hidden = false;
    button.addEventListener("click", () => turn(Number(button.dataset.turn) < 0 ? -1 : 1));
  }
  if (turnBar instanceof view.HTMLElement) turnBar.hidden = false;
  document.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.defaultPrevented) return;
    const target = event.target;
    if (target instanceof view.HTMLElement && (target.isContentEditable || target.closest("input, textarea, select") !== null)) return;
    if (event.key === "ArrowRight") turn(1);
    else if (event.key === "ArrowLeft") turn(-1);
    else return;
    event.preventDefault();
  });

  book.dataset.paged = "";
  metrics = measure();
  show();
  openAt(view.location.hash);
  new view.ResizeObserver(relayout).observe(spread);
  void document.fonts.ready.then(relayout);
  view.addEventListener("hashchange", () => openAt(view.location.hash));
}

if ("document" in globalThis) enhanceBook(globalThis.document);
