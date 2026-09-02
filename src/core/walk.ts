import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

import type { Run, Transcript } from "../contracts/transcript";

export type Metadata = { title: string | null; author: string | null };

function clean(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed === "" ? null : collapsed.slice(0, 500);
}

// Reads metadata from the original HTML because sanitization removes `meta`
// elements, including Open Graph titles and author values.
export function metadata(html: string): Metadata {
  const doc = new JSDOM(html).window.document;

  const title =
    clean(doc.querySelector('meta[property="og:title"]')?.getAttribute("content")) ??
    clean(doc.querySelector("title")?.textContent) ??
    clean(doc.querySelector("h1")?.textContent);

  const author =
    clean(doc.querySelector('meta[name="author"]')?.getAttribute("content")) ??
    clean(doc.querySelector('meta[property="article:author"]')?.getAttribute("content"));

  return { title, author };
}

export const BLOCK_ELEMENTS = [
  "address",
  "article",
  "aside",
  "blockquote",
  "caption",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
];

const BLOCK_SET = new Set(BLOCK_ELEMENTS);

type Item = {
  kind: "text" | "break";
  path: string;
  raw: string;
  owner: Element;
  pre: boolean;
};

function pathOf(node: Node, root: Element): string {
  const parts: number[] = [];
  let current: Node | null = node;
  while (current && current !== root) {
    const parent: Node | null = current.parentNode;
    if (!parent) return "";
    parts.unshift(Array.prototype.indexOf.call(parent.childNodes, current));
    current = parent;
  }
  return parts.join("/");
}

function contentPaths(doc: Document): Set<string> | null {
  const clone = doc.cloneNode(true) as Document;
  for (const el of clone.querySelectorAll("*")) {
    el.setAttribute("data-cp-path", pathOf(el, clone.documentElement));
  }
  const article = new Readability(clone as never).parse();
  if (!article) return null;
  const kept = new JSDOM(article.content ?? "").window.document;
  const paths = new Set<string>();
  for (const el of kept.querySelectorAll("[data-cp-path]")) {
    paths.add(el.getAttribute("data-cp-path")!);
  }
  return paths.size === 0 ? null : paths;
}

function isContentPath(kept: Set<string> | null, path: string): boolean {
  if (kept === null) return true;
  if (kept.has(path)) return true;
  for (const k of kept) if (path.startsWith(`${k}/`)) return true;
  return false;
}

export function walk(
  sanitizedHtml: string,
  options: { docIndex?: number; startOffset?: number; startBlockIndex?: number } = {},
): Transcript {
  const docIndex = options.docIndex ?? 0;
  const startOffset = options.startOffset ?? 0;
  const startBlockIndex = options.startBlockIndex ?? 0;

  const doc = new JSDOM(sanitizedHtml).window.document;
  const root = doc.documentElement;
  const kept = contentPaths(doc);

  const items: Item[] = [];
  const collect = (node: Node, owner: Element, pre: boolean): void => {
    if (node.nodeType === 3) {
      items.push({ kind: "text", path: pathOf(node, root), raw: (node as Text).data, owner, pre });
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === "br") {
      items.push({ kind: "break", path: pathOf(el, root), raw: "\n", owner, pre });
      return;
    }
    if (tag === "img" || tag === "wbr") return;
    const nextOwner = BLOCK_SET.has(tag) ? el : owner;
    const nextPre = pre || tag === "pre";
    for (const child of el.childNodes) collect(child, nextOwner, nextPre);
  };
  const body = doc.body;
  if (body) for (const child of body.childNodes) collect(child, body, false);

  // Start a segment when the owning block changes. A parent block can therefore
  // have separate segments before and after a nested block.
  const segments: Item[][] = [];
  for (const item of items) {
    const last = segments[segments.length - 1];
    if (last && last[0]!.owner === item.owner) last.push(item);
    else segments.push([item]);
  }

  type Chunk = { text: string; path: string };
  type Block = { owner: Element; chunks: Chunk[] };

  const blocks: Block[] = [];
  for (const segment of segments) {
    const owner = segment[0]!.owner;
    const pre = segment[0]!.pre;
    const chunks: Chunk[] = [];
    if (pre) {
      for (const item of segment) {
        chunks.push({ text: item.raw, path: item.path });
      }
    } else {
      let started = false;
      let pending = false;
      for (const item of segment) {
        if (item.kind === "break") {
          pending = false;
          started = false;
          chunks.push({ text: "\n", path: item.path });
          continue;
        }
        const collapsed = item.raw.replace(/[ \t\n\r\f]+/g, " ");
        const core = collapsed.trim();
        if (core === "") {
          if (started) pending = true;
          continue;
        }
        const prefix = started && (pending || collapsed.startsWith(" ")) ? " " : "";
        pending = collapsed.endsWith(" ");
        started = true;
        chunks.push({ text: prefix + core, path: item.path });
      }
    }
    if (chunks.length > 0) blocks.push({ owner, chunks });
  }

  // Remove leading and trailing line breaks before assigning block indices.
  // Keep a leading break when `startOffset` is nonzero because it separates
  // this document from the preceding chapter.
  const chunks = blocks.flatMap((block) => block.chunks);
  if (startOffset === 0) {
    while (chunks.length > 0 && chunks[0]!.text.startsWith("\n")) {
      const first = chunks[0]!;
      first.text = first.text.replace(/^\n+/, "");
      if (first.text === "") chunks.shift();
    }
  }
  while (chunks.length > 0 && chunks[chunks.length - 1]!.text.endsWith("\n")) {
    const last = chunks[chunks.length - 1]!;
    last.text = last.text.replace(/\n+$/, "");
    if (last.text === "") chunks.pop();
  }
  for (const block of blocks) {
    block.chunks = block.chunks.filter((chunk) => chunk.text.length > 0);
  }

  const runs: Run[] = [];
  let text = "";
  let offset = startOffset;
  let nextBlock = startBlockIndex;
  let previous: { path: string; block: number; content: boolean } | null = null;

  const push = (chunk: string, path: string, block: number, content: boolean): void => {
    if (chunk.length === 0) return;
    runs.push({
      start: offset,
      end: offset + chunk.length,
      doc_index: docIndex,
      node_path: path,
      block_index: block,
      is_content: content,
    });
    offset += chunk.length;
    text += chunk;
  };

  for (const block of blocks) {
    if (block.chunks.length === 0) continue;
    const ownerPath = pathOf(block.owner, root);
    const content = isContentPath(kept, ownerPath);
    const blockIndex = nextBlock;
    nextBlock += 1;

    const needsSeparator =
      (text.length > 0 || startOffset > 0) && !text.endsWith("\n");
    if (needsSeparator) {
      const carrier = previous ?? { path: ownerPath, block: blockIndex, content };
      push("\n", carrier.path, carrier.block, carrier.content);
    }

    for (const chunk of block.chunks) {
      push(chunk.text, chunk.path, blockIndex, content);
    }
    previous = { path: ownerPath, block: blockIndex, content };
  }

  return { text, map: { runs } };
}
