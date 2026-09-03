import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import { AppError } from "../../src/contracts/errors";
import { validateMap } from "../../src/contracts/transcript";
import { sanitize } from "../../src/core/sanitize";
import { walk } from "../../src/core/walk";

const HOSTILE = `<html><body><script>alert(1)</script><p onclick="bad">Attributes are dropped and this text stays.</p><a href="javascript:bad">bad</a><a href="#fragment">fragment</a><img src="pictures/dot.png"><form>Form text survives the unwrap.</form><noscript><img src="pictures/lazy.png"></noscript></body></html>`;
const ARTICLE = "<html><body><article><p>Article text has enough prose to remain content.</p></article><nav>Navigation text</nav></body></html>";

function isElement(node: Node): node is Element {
  return node.nodeType === 1;
}

function ancestors(html: string, path: string): string[] {
  const document = new JSDOM(html).window.document;
  let node: Node | null = document.documentElement;
  for (const part of path.split("/")) node = node?.childNodes[Number(part)] ?? null;
  const tags: string[] = [];
  while (node) {
    if (isElement(node)) tags.push(node.tagName.toLowerCase());
    node = node.parentNode;
  }
  return tags;
}

describe("sanitization", () => {
  test("removes executable markup and unsafe attributes while keeping useful text", () => {
    const clean = sanitize(HOSTILE);
    const lower = clean.toLowerCase();
    expect(lower).not.toContain("<script");
    expect(lower).not.toContain("onclick");
    expect(lower).not.toContain("javascript");
    expect(clean).toContain("Attributes are dropped and this text stays.");
    expect(clean).toContain('href="#fragment"');
  });

  test("retains relative images, form text, and noscript content", () => {
    const clean = sanitize(HOSTILE);
    expect(clean).toContain('src="pictures/dot.png"');
    expect(clean).toContain("Form text survives the unwrap.");
    expect(clean).toContain('src="pictures/lazy.png"');
  });

  test("is stable when sanitizing an already sanitized document", () => {
    const clean = sanitize(HOSTILE);
    expect(sanitize(clean)).toBe(clean);
  });

  test("rejects empty input with an application error", () => {
    expect(() => sanitize(" \n\t ")).toThrow(AppError);
  });
});

describe("transcript and map", () => {
  test("linearizes blocks, inline text, and breaks in reading order", () => {
    const { text, map } = walk(sanitize(`
      <html><body><h1>Heading</h1><p>First <em>short</em> paragraph<br>next line.</p>
      <p>Last block.</p></body></html>
    `));
    expect(text).toBe("Heading\nFirst short paragraph\nnext line.\nLast block.");
    expect(() => validateMap(map, text.length)).not.toThrow();
    expect(map.runs.map((run) => text.slice(run.start, run.end)).join("")).toBe(text);
    expect(map.runs.some((run) => text.slice(run.start, run.end) === "\n")).toBe(true);
  });

  test("preserves preformatted whitespace and counts astral text in UTF-16", () => {
    const pre = walk(sanitize("<html><body><pre>  a  \n  b  </pre></body></html>"));
    expect(pre.text).toBe("  a  \n  b  ");

    const astral = walk(sanitize("<html><body><p>hello 😀 world</p></body></html>"));
    expect(astral.text).toContain("😀");
    expect(astral.text.length).toBeGreaterThan(astral.text.replaceAll("😀", "").length);
    expect(() => validateMap(astral.map, astral.text.length)).not.toThrow();
    for (const run of astral.map.runs) {
      for (const boundary of [run.start, run.end]) {
        if (boundary === 0 || boundary === astral.text.length) continue;
        const before = astral.text.charCodeAt(boundary - 1);
        expect(before >= 0xd800 && before <= 0xdbff).toBe(false);
      }
    }
  });

  test("classifies article text as content and navigation as non-content", () => {
    const clean = sanitize(ARTICLE);
    const result = walk(clean);
    const article = result.map.runs.filter((run) => ancestors(clean, run.node_path).includes("article"));
    const navigation = result.map.runs.filter((run) => ancestors(clean, run.node_path).includes("nav"));
    expect(article.length).toBeGreaterThan(0);
    expect(navigation.length).toBeGreaterThan(0);
    expect(article.every((run) => run.is_content)).toBe(true);
    expect(navigation.every((run) => !run.is_content)).toBe(true);
  });

  test("keeps separators with the previous block and preserves break runs", () => {
    const clean = sanitize("<html><body><p>first</p><p>second</p><p>x<br><br>y</p></body></html>");
    const result = walk(clean);
    expect(result.text).toBe("first\nsecond\nx\n\ny");
    const separator = result.map.runs.find((run) => result.text.slice(run.start, run.end) === "\n")!;
    expect(separator.block_index).toBe(0);
    expect(ancestors(clean, separator.node_path)).toContain("p");
    expect(result.map.runs.filter((run) => result.text.slice(run.start, run.end) === "\n").length).toBe(4);
  });

  test("handles entities, tables, void elements, RTL text, and body text", () => {
    const clean = sanitize(`<html><body>lead <p>a&nbsp; b <img src="x"> c</p><table><tr><td>cell</td><td>two</td></tr></table><p>שלום<br>עולם</p></body></html>`);
    const result = walk(clean);
    expect(result.text).toBe("lead\na\u00a0 b c\ncell\ntwo\nשלום\nעולם");
    expect(() => validateMap(result.map, result.text.length)).not.toThrow();

    const document = new JSDOM(clean).window.document;
    const blocks = new Map<number, boolean>();
    for (const run of result.map.runs) {
      let node: Node | null = document.documentElement;
      for (const part of run.node_path.split("/")) node = node?.childNodes[Number(part)] ?? null;
      expect(node).not.toBeNull();
      const previous = blocks.get(run.block_index);
      if (previous === undefined) blocks.set(run.block_index, run.is_content);
      else expect(run.is_content).toBe(previous);
    }
  });

  test("does not include head metadata in the transcript", () => {
    const clean = sanitize("<html><head><title>Private title</title></head><body><p>Body text</p></body></html>");
    expect(walk(clean).text).toBe("Body text");
  });
});
