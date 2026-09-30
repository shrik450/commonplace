import { submitInPlace } from "./submit";

// Turns a selection in the reader into a clipping. The projected transcript
// wraps each run of text in an element whose `data-cp-start` is the run's
// offset in the transcript, and the run's text is exactly that stretch of the
// transcript. So a point in the page maps back to a transcript offset by
// counting characters from the start of its run.

const RUN = "[data-cp-path]";

export type SelectionOffsets = { start: number; end: number };

function runOf(node: Node): Element | null {
  // SAFETY: nodeType 1 identifies an Element node.
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
  return element?.closest(RUN) ?? null;
}

function offsetInRun(document: Document, run: Element, node: Node, offset: number): number {
  const range = document.createRange();
  range.setStart(run, 0);
  range.setEnd(node, offset);
  return Number(run.getAttribute("data-cp-start")) + range.toString().length;
}

// Maps one end of a selection to a transcript offset. A point between runs,
// such as between two paragraphs, moves to the nearest run inward: forward for
// the start, backward for the end.
function pointOffset(
  document: Document,
  runs: readonly Element[],
  node: Node,
  offset: number,
  edge: "start" | "end",
): number | null {
  const run = runOf(node);
  if (run !== null && runs.includes(run)) return offsetInRun(document, run, node, offset);
  const point = document.createRange();
  point.setStart(node, offset);
  if (edge === "start") {
    const next = runs.find((candidate) => point.comparePoint(candidate, 0) > 0);
    return next === undefined ? null : Number(next.getAttribute("data-cp-start"));
  }
  const previous = runs.findLast((candidate) => point.comparePoint(candidate, candidate.childNodes.length) < 0);
  return previous === undefined
    ? null
    : Number(previous.getAttribute("data-cp-start")) + (previous.textContent ?? "").length;
}

// The transcript offsets a selection covers within `container`, or `null`
// when it covers no text there.
export function selectionOffsets(container: Element, selection: Selection): SelectionOffsets | null {
  if (selection.rangeCount === 0 || selection.isCollapsed) return null;
  const document = container.ownerDocument;
  const range = selection.getRangeAt(0);
  if (!range.intersectsNode(container)) return null;
  const runs = [...container.querySelectorAll(RUN)];
  const start = pointOffset(document, runs, range.startContainer, range.startOffset, "start");
  const end = pointOffset(document, runs, range.endContainer, range.endOffset, "end");
  if (start === null || end === null || end <= start) return null;
  return { start, end };
}

export function enhanceClipping(document: Document): void {
  const view = document.defaultView;
  const reader = document.querySelector("[data-cp-reader]");
  const form = document.querySelector("[data-clip-form]");
  const pop = document.querySelector("[data-clip-pop]");
  const slip = document.querySelector("[data-clip-slip]");
  const note = document.querySelector("#clip-note");
  const error = document.querySelector("[data-clip-error]");
  const status = document.querySelector("[data-clip-status]");
  const openNote = document.querySelector("[data-clip-open-note]");
  const cancel = document.querySelector("[data-clip-cancel]");
  if (
    view === null ||
    !(reader instanceof view.HTMLElement) ||
    !(form instanceof view.HTMLFormElement) ||
    !(pop instanceof view.HTMLElement) ||
    !(slip instanceof view.HTMLElement) ||
    !(note instanceof view.HTMLTextAreaElement) ||
    !(error instanceof view.HTMLElement) ||
    !(status instanceof view.HTMLElement) ||
    !(openNote instanceof view.HTMLButtonElement) ||
    !(cancel instanceof view.HTMLButtonElement)
  ) return;
  const start = form.elements.namedItem("start");
  const end = form.elements.namedItem("end");
  if (!(start instanceof view.HTMLInputElement) || !(end instanceof view.HTMLInputElement)) return;

  // The sheet is replaced after each clipping, so its text is looked up fresh.
  const projected = (): HTMLElement | null => {
    const text = reader.querySelector("[data-cp-projected]");
    return text instanceof view.HTMLElement ? text : null;
  };

  // The passage the pop-up or the note slip is about. While the slip has
  // focus the page has no selection, so the passage is marked by a highlight.
  let passage: Range | null = null;
  let saving = false;
  const PENDING = "cp-pending";

  const hidePop = () => {
    pop.hidden = true;
  };

  const closeSlip = () => {
    slip.hidden = true;
    error.hidden = true;
    note.value = "";
    view.CSS.highlights.delete(PENDING);
  };

  const place = (bounds: DOMRect) => {
    const frame = reader.getBoundingClientRect();
    const column = projected()?.getBoundingClientRect() ?? frame;
    const width = Math.min(column.width, 512);
    const centre = bounds.left + bounds.width / 2;
    const left = Math.min(Math.max(centre - width / 2, column.left), column.right - width);
    reader.style.setProperty("--pop-x", String(centre - frame.left));
    reader.style.setProperty("--pop-top", String(bounds.top - frame.top));
    reader.style.setProperty("--pop-bottom", String(bounds.bottom - frame.top));
    reader.style.setProperty("--slip-x", String(left - frame.left));
    reader.style.setProperty("--slip-width", String(width));
  };

  const update = () => {
    if (!slip.hidden || saving) return;
    const selection = document.getSelection();
    const text = projected();
    const offsets = selection === null || text === null ? null : selectionOffsets(text, selection);
    if (selection === null || offsets === null) return hidePop();
    start.value = String(offsets.start);
    end.value = String(offsets.end);
    passage = selection.getRangeAt(0).cloneRange();
    place(passage.getBoundingClientRect());
    pop.hidden = false;
  };

  const showSlip = (message: string | null) => {
    hidePop();
    if (passage !== null) view.CSS.highlights.set(PENDING, new view.Highlight(passage));
    error.textContent = message ?? "";
    error.hidden = message === null;
    slip.hidden = false;
    note.focus({ preventScroll: true });
    slip.scrollIntoView({ block: "nearest" });
  };

  // `label` is the pressed button's label, which reads "Saving…" meanwhile.
  const save = async (label: Element | null) => {
    if (saving) return;
    saving = true;
    reader.setAttribute("aria-busy", "true");
    const idle = label?.textContent ?? "";
    if (label !== null) label.textContent = "Saving…";
    const withNote = note.value.trim() !== "";
    const answer = await submitInPlace(view, form.action, new URLSearchParams({ start: start.value, end: end.value, note: note.value }));
    saving = false;
    reader.removeAttribute("aria-busy");
    if (label !== null) label.textContent = idle;
    if (answer.kind === "refused") return showSlip(answer.message);
    // The server answers with the reader, now carrying the new mark, its
    // number, and the ribbon's count. Its sheet replaces this one, so the
    // reader stays where they were. Any other page, such as the sign-in page
    // after a session ends, means the clipping wasn't made.
    const sheet = answer.path === view.location.pathname ? answer.page.querySelector(".reader-sheet") : null;
    if (sheet === null) return showSlip("Commonplace couldn't save the clipping. Reload the page, and try again.");
    reader.querySelector(".reader-sheet")?.replaceWith(document.adoptNode(sheet));
    passage = null;
    closeSlip();
    hidePop();
    document.getSelection()?.removeAllRanges();
    status.textContent = withNote ? "Clipped, with your note." : "Clipped.";
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void save(event.submitter?.querySelector("[data-clip-label]") ?? null);
  });

  // Pressing a pop-up button would otherwise clear the selection first.
  pop.addEventListener("pointerdown", (event) => event.preventDefault());
  openNote.addEventListener("click", () => showSlip(null));
  cancel.addEventListener("click", closeSlip);
  // A note in progress is only thrown away on purpose, with Cancel.
  view.addEventListener("beforeunload", (event) => {
    if (!slip.hidden && note.value.trim() !== "") event.preventDefault();
  });

  // Selections change by mouse, touch handles, and keyboard alike. Offer the
  // pop-up once a selection settles, and not while a pointer is still dragging.
  let dragging = false;
  let settle = 0;
  reader.addEventListener("pointerdown", (event) => {
    const text = projected();
    if (event.target instanceof view.Node && text?.contains(event.target)) dragging = true;
  });
  document.addEventListener("pointerup", () => {
    if (!dragging) return;
    dragging = false;
    view.clearTimeout(settle);
    settle = view.setTimeout(update, 0);
  });
  document.addEventListener("selectionchange", () => {
    view.clearTimeout(settle);
    if (!slip.hidden) return;
    if (document.getSelection()?.isCollapsed !== false) return hidePop();
    if (!dragging) settle = view.setTimeout(update, 250);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (slip.hidden) hidePop();
    else if (note.value.trim() === "") closeSlip();
  });
}

if ("document" in globalThis) enhanceClipping(globalThis.document);
