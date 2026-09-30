import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import { parseClipSelection, parseNote } from "../../src/contracts/clipping";
import { newAnnotationId } from "../../src/contracts/ids";
import { clipRange, MAX_CLIP_LENGTH } from "../../src/core/clip";
import { project } from "../../src/core/project";
import { sanitize } from "../../src/core/sanitize";
import { shuffled } from "../../src/core/shuffle";
import { walk } from "../../src/core/walk";
import { selectionOffsets } from "../../src/web/client/clip";

const PAGE = "<html><body><article><h1>Heading</h1>" +
  "<p>First paragraph with <em>emphasis</em> and a <a href='https://example.com'>link</a> in it, long enough to count as article content.</p>" +
  "<p>Second paragraph<br>after a line break, also long enough to be part of the readable article.</p>" +
  "</article><nav><p>Navigation outside the article text.</p></nav></body></html>";

function transcriptOf(html: string) {
  const sanitized = sanitize(html);
  return { sanitized, ...walk(sanitized) };
}

describe("clipRange", () => {
  const { text, map } = transcriptOf(PAGE);
  const at = (quote: string) => ({ start: text.indexOf(quote), end: text.indexOf(quote) + quote.length });

  test("keeps a passage of article text", () => {
    expect(clipRange(text, map, at("with emphasis and"))).toEqual(at("with emphasis and"));
  });

  test("trims whitespace from both ends", () => {
    const inner = at("emphasis");
    expect(clipRange(text, map, { start: inner.start - 1, end: inner.end + 1 })).toEqual(inner);
  });

  test("spans paragraphs", () => {
    const from = text.indexOf("in it,");
    const to = text.indexOf("Second paragraph") + "Second paragraph".length;
    expect(clipRange(text, map, { start: from, end: to })).toEqual({ start: from, end: to });
  });

  test("refuses text outside the article, even partly", () => {
    expect(clipRange(text, map, at("Navigation outside"))).toBeNull();
    expect(clipRange(text, map, { start: text.indexOf("readable article"), end: text.indexOf("outside") })).toBeNull();
  });

  test("refuses empty, reversed, fractional, out-of-bounds, and whitespace-only ranges", () => {
    for (const range of [
      { start: 5, end: 5 },
      { start: 9, end: 4 },
      { start: 0.5, end: 4 },
      { start: -1, end: 4 },
      { start: 0, end: text.length + 1 },
    ]) {
      expect(clipRange(text, map, range)).toBeNull();
    }
    const space = text.indexOf(" ");
    expect(clipRange(text, map, { start: space, end: space + 1 })).toBeNull();
  });

  test("refuses a passage longer than a clipping may be", () => {
    const long = transcriptOf(`<html><body><article><p>${"word ".repeat(MAX_CLIP_LENGTH / 4)}</p></article></body></html>`);
    expect(clipRange(long.text, long.map, { start: 0, end: long.text.trimEnd().length })).toBeNull();
    expect(clipRange(long.text, long.map, { start: 0, end: MAX_CLIP_LENGTH })).not.toBeNull();
  });
});

describe("clipping form fields", () => {
  test("offsets must be whole numbers", () => {
    expect(parseClipSelection(new URLSearchParams({ start: "4", end: "12" }))).toEqual({ start: 4, end: 12 });
    const malformed: Record<string, string>[] = [
      { start: "", end: "3" },
      { start: "4" },
      { start: "four", end: "5" },
      { start: "1.5", end: "5" },
      { start: "1e400", end: "5" },
    ];
    for (const fields of malformed) {
      expect(() => parseClipSelection(new URLSearchParams(fields))).toThrow();
    }
  });

  test("a note is trimmed, blank is none, and it has a length limit", () => {
    expect(parseNote("  keep this  ")).toBe("keep this");
    expect(parseNote("   ")).toBeNull();
    expect(parseNote(null)).toBeNull();
    expect(parseNote("x".repeat(2_000))).toHaveLength(2_000);
    expect(() => parseNote("x".repeat(2_001))).toThrow();
  });
});

describe("selectionOffsets", () => {
  const { sanitized, text, map } = transcriptOf(PAGE);
  const id = newAnnotationId();
  const existing = { id, start: text.indexOf("First paragraph"), end: text.indexOf("First paragraph") + 5 };
  const dom = new JSDOM(`<div id="text">${project({ sanitizedHtml: sanitized, transcript: text, map, highlights: [existing] })}</div>`);
  const document = dom.window.document;
  const container = document.getElementById("text")!;

  function select(startNode: Node, startOffset: number, endNode: Node, endOffset: number) {
    const selection = dom.window.getSelection()!;
    selection.removeAllRanges();
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    selection.addRange(range);
    return selection;
  }

  function textNodeContaining(fragment: string): Text {
    const walker = document.createTreeWalker(container, dom.window.NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (node instanceof dom.window.Text && node.textContent.includes(fragment)) return node;
    }
    throw new Error(`no text node contains ${fragment}`);
  }

  test("a selection inside one run maps to its transcript offsets", () => {
    const node = textNodeContaining("and a");
    const at = node.textContent!.indexOf("and a");
    const offsets = selectionOffsets(container, select(node, at, node, at + 5))!;
    expect(text.slice(offsets.start, offsets.end)).toBe("and a");
  });

  test("a selection across emphasis, links, and an existing highlight still maps exactly", () => {
    const from = textNodeContaining("First");
    // The walk folds the space before "link" into its run, so its text node
    // reads " link".
    const to = textNodeContaining("link");
    const offsets = selectionOffsets(container, select(from, 0, to, to.textContent!.length))!;
    expect(text.slice(offsets.start, offsets.end)).toBe("First paragraph with emphasis and a link");
  });

  test("a selection across a line break and paragraphs maps to the transcript between", () => {
    const from = textNodeContaining("in it,");
    const to = textNodeContaining("after a line");
    const offsets = selectionOffsets(container, select(from, from.textContent!.indexOf("in it"), to, 5))!;
    expect(text.slice(offsets.start, offsets.end)).toStartWith("in it,");
    expect(text.slice(offsets.start, offsets.end)).toEndWith("after");
  });

  test("an end point between blocks snaps back to the last run", () => {
    const from = textNodeContaining("Second");
    const paragraph = from.parentElement!.closest("p")!;
    const offsets = selectionOffsets(container, select(from, 0, paragraph, paragraph.childNodes.length))!;
    expect(text.slice(offsets.start, offsets.end)).toStartWith("Second paragraph");
    expect(text.slice(offsets.start, offsets.end).trimEnd()).toEndWith("readable article.");
  });

  test("a collapsed selection, or one outside the text, is nothing to clip", () => {
    const node = textNodeContaining("Second");
    expect(selectionOffsets(container, select(node, 2, node, 2))).toBeNull();
    const outside = document.createElement("p");
    outside.textContent = "elsewhere";
    document.body.append(outside);
    expect(selectionOffsets(container, select(outside.firstChild!, 0, outside.firstChild!, 4))).toBeNull();
  });
});

describe("shuffled", () => {
  const list = Array.from({ length: 20 }, (_, index) => index);

  test("keeps every entry", () => {
    expect(shuffled(list, 7).toSorted((a, b) => a - b)).toEqual(list);
  });

  test("the same seed gives the same order, and different seeds differ", () => {
    expect(shuffled(list, 7)).toEqual(shuffled(list, 7));
    expect(shuffled(list, 7)).not.toEqual(shuffled(list, 8));
    expect(shuffled(list, 7)).not.toEqual(list);
  });

  test("leaves its input alone and handles tiny lists", () => {
    const input = [1, 2, 3];
    shuffled(input, 3);
    expect(input).toEqual([1, 2, 3]);
    expect(shuffled([], 3)).toEqual([]);
    expect(shuffled(["only"], 3)).toEqual(["only"]);
  });
});
