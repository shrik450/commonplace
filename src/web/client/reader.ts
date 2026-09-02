// The reader's only script. It turns a browser selection into transcript
// offsets by reading the attributes the server emitted, and it carries no
// auth logic of its own: it rides the same-origin session cookie.

const RUN_ATTRIBUTE = "data-cp-path";
const START_ATTRIBUTE = "data-cp-start";

function runSpanOf(node: Node): Element | null {
  let current: Node | null = node;
  while (current) {
    if (
      current.nodeType === 1 &&
      (current as Element).hasAttribute(RUN_ATTRIBUTE)
    ) {
      return current as Element;
    }
    current = current.parentNode;
  }
  return null;
}

// Counts the characters before a point inside its run. A run span holds text
// and highlight marks, so the count walks the subtree rather than trusting a
// single text node. Returns null for a point that sits outside every run,
// which is what the chrome around the transcript is.
export function offsetOfPoint(node: Node, offset: number): number | null {
  const span = runSpanOf(node);
  if (span === null) return null;

  const start = Number(span.getAttribute(START_ATTRIBUTE));
  if (!Number.isInteger(start)) return null;

  let count = 0;
  const seek = (current: Node): boolean => {
    if (current === node) {
      count += offset;
      return true;
    }
    if (current.nodeType === 3) {
      count += (current as Text).data.length;
      return false;
    }
    for (const child of current.childNodes) {
      if (seek(child)) return true;
    }
    return false;
  };
  if (!seek(span)) return null;

  return start + count;
}

export type SelectedRange = { start: number; end: number; quote: string };

export function rangeOfSelection(
  selection: Selection | null,
): SelectedRange | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }
  const range = selection.getRangeAt(0);
  const start = offsetOfPoint(range.startContainer, range.startOffset);
  const end = offsetOfPoint(range.endContainer, range.endOffset);
  if (start === null || end === null || end <= start) return null;

  return { start, end, quote: selection.toString() };
}

function announce(range: SelectedRange | null): void {
  const article = document.querySelector(".cp-transcript");
  if (!article) return;

  if (range === null) {
    article.removeAttribute("data-cp-selection");
    return;
  }
  article.setAttribute("data-cp-selection", `${range.start}-${range.end}`);
  article.dispatchEvent(
    new CustomEvent("cp:selection", { detail: range, bubbles: true }),
  );
}

function toggleTheme(): void {
  const root = document.documentElement;
  const next = root.getAttribute("data-theme") === "ink" ? "parchment" : "ink";
  root.setAttribute("data-theme", next);
  localStorage.setItem("cp-theme", next);
}

function bootstrap(): void {
  document.addEventListener("selectionchange", () => {
    announce(rangeOfSelection(document.getSelection()));
  });
  document
    .querySelector("[data-cp-theme-toggle]")
    ?.addEventListener("click", toggleTheme);

  const saved = localStorage.getItem("cp-theme");
  if (saved) document.documentElement.setAttribute("data-theme", saved);
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }
}
