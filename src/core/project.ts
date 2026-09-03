import { JSDOM } from "jsdom";

import type { AnnotationId } from "../contracts/ids";
import { blocksOf, type Run, type TranscriptMap } from "../contracts/transcript";
import { BLOCK_ELEMENTS } from "./sanitize";
import { contentPaths as readabilityPaths } from "./walk";

export type Highlight = { id: AnnotationId; start: number; end: number };

export type ProjectionMode = "reader" | "structured";

export type ProjectInput = {
  sanitizedHtml: string;
  transcript: string;
  map: TranscriptMap;
  highlights?: Highlight[];
  mode?: ProjectionMode;
};

const BLOCK_SET = new Set(BLOCK_ELEMENTS);
const STRUCTURED_TAGS = new Set([
  ...BLOCK_ELEMENTS,
  "a", "abbr", "b", "bdi", "bdo", "br", "code", "cite", "del", "em",
  "i", "img", "ins", "kbd", "mark", "noscript", "q", "s", "samp", "small",
  "span", "strong", "sub", "sup", "time", "u", "var", "wbr",
]);

function escape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function nodeAt(root: Element, path: string): Node | null {
  if (path === "") return root;
  let current: Node = root;
  for (const part of path.split("/")) {
    const index = Number(part);
    const child = current.childNodes[index];
    if (!child) return null;
    current = child;
  }
  return current;
}

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

function ownerPath(root: Element, path: string): string {
  let node = nodeAt(root, path);
  while (node) {
    if (node.nodeType === 1) {
      // SAFETY: nodeType 1 identifies a DOM Element node.
      const tag = (node as Element).tagName.toLowerCase();
      if (BLOCK_SET.has(tag)) return pathOf(node, root);
    }
    node = node.parentNode;
  }
  return "";
}

function usable(highlights: Highlight[], length: number): Highlight[] {
  return highlights.filter(
    (highlight) =>
      highlight.end > highlight.start &&
      highlight.start < length &&
      highlight.end > 0,
  );
}

function cutsIn(run: Run, highlights: Highlight[]): number[] {
  const cuts = new Set<number>([run.start, run.end]);
  for (const highlight of highlights) {
    if (highlight.start > run.start && highlight.start < run.end) {
      cuts.add(highlight.start);
    }
    if (highlight.end > run.start && highlight.end < run.end) {
      cuts.add(highlight.end);
    }
  }
  return [...cuts].toSorted((a, b) => a - b);
}

function piece(
  transcript: string,
  start: number,
  end: number,
  highlights: Highlight[],
): string {
  const covering = highlights.filter(
    (highlight) => highlight.start <= start && highlight.end >= end,
  );
  let html = escape(transcript.slice(start, end));
  for (const highlight of covering.toReversed()) {
    html = `<mark class="cp-mark" data-cp-annotation="${escape(highlight.id)}">${html}</mark>`;
  }
  return html;
}

function embeddedImageSource(source: string): boolean {
  return /^data:image\/(?:png|jpeg|jpg|gif|webp|avif|bmp|svg\+xml|x-icon|vnd\.microsoft\.icon)(?:[;,])/i.test(source);
}

function attribute(name: string, value: string | null | undefined): string {
  return value === null || value === undefined
    ? ""
    : ` ${name}="${escape(value)}"`;
}

function attributes(tag: string, element: Element): string {
  let result = attribute("lang", element.getAttribute("lang"));
  result += attribute("dir", element.getAttribute("dir"));
  if (tag === "a") {
    result += attribute("href", element.getAttribute("href"));
    result += attribute("title", element.getAttribute("title"));
    if (element.hasAttribute("href")) result += ' rel="noreferrer noopener"';
  } else if (tag === "img") {
    const source = element.getAttribute("src");
    if (source !== null && embeddedImageSource(source)) {
      result += attribute("src", source);
    }
    result += attribute("alt", element.getAttribute("alt") ?? "");
    result += attribute("title", element.getAttribute("title"));
    result += attribute("width", element.getAttribute("width"));
    result += attribute("height", element.getAttribute("height"));
    result += ' loading="lazy"';
  } else if (tag === "td" || tag === "th") {
    result += attribute("colspan", element.getAttribute("colspan"));
    result += attribute("rowspan", element.getAttribute("rowspan"));
    if (tag === "th") result += attribute("scope", element.getAttribute("scope"));
  } else if (tag === "ol") {
    result += attribute("start", element.getAttribute("start"));
    if (element.hasAttribute("reversed")) result += " reversed";
    result += attribute("type", element.getAttribute("type"));
  } else if (tag === "time") {
    result += attribute("datetime", element.getAttribute("datetime"));
  }
  return result;
}

function mappedPaths(map: TranscriptMap, includeNonContent: boolean): Set<string> {
  const paths = new Set<string>();
  for (const run of map.runs) {
    if (!includeNonContent && !run.is_content) continue;
    const parts = run.node_path === "" ? [] : run.node_path.split("/");
    for (let length = 0; length <= parts.length; length += 1) {
      paths.add(parts.slice(0, length).join("/"));
    }
  }
  return paths;
}

function isPathContent(kept: Set<string> | null, path: string): boolean {
  if (kept === null) return true;
  if (kept.has(path)) return true;
  for (const candidate of kept) {
    if (path.startsWith(`${candidate}/`)) return true;
  }
  return false;
}

function containsImage(node: Node): boolean {
  // SAFETY: nodeType 1 identifies the Element node used for tagName.
  if (node.nodeType === 1 && (node as Element).tagName.toLowerCase() === "img") {
    return true;
  }
  return [...node.childNodes].some(containsImage);
}

// Project transcript text through the sanitized DOM. The transcript remains
// the source for text so highlights keep their UTF-16 ranges.
export function project(input: ProjectInput): string {
  const { sanitizedHtml, transcript, map } = input;
  const mode = input.mode ?? "reader";
  const includeNonContent = mode === "structured";
  const highlights = usable(input.highlights ?? [], transcript.length);
  const document = new JSDOM(sanitizedHtml).window.document;
  const root = document.documentElement;
  const paths = mappedPaths(map, includeNonContent);
  // SAFETY: readabilityPaths receives the same parsed sanitized document as walk.
  const readable = readabilityPaths(document);
  const runsByPath = new Map<string, Run[]>();
  const firstRunByBlock = new Map<number, Run>();
  for (const run of map.runs) {
    if (!includeNonContent && !run.is_content) continue;
    const runs = runsByPath.get(run.node_path) ?? [];
    runs.push(run);
    runsByPath.set(run.node_path, runs);
    if (!firstRunByBlock.has(run.block_index)) {
      firstRunByBlock.set(run.block_index, run);
    }
  }

  const blockRanges = new Map<number, { start: number; end: number; tag: string }>();
  for (const block of blocksOf(map)) {
    const first = block.runs[0]!;
    const last = block.runs.at(-1)!;
    const owner = nodeAt(root, ownerPath(root, first.node_path));
    const tag = owner?.nodeType === 1
      ? // SAFETY: the nodeType guard proves that owner is an Element.
        (owner as Element).tagName.toLowerCase()
      : "p";
    blockRanges.set(block.index, { start: first.start, end: last.end, tag });
  }

  const renderRun = (run: Run, className = ""): string => {
    const cuts = cutsIn(run, highlights);
    const content: string[] = [];
    for (let i = 0; i < cuts.length - 1; i += 1) {
      content.push(piece(transcript, cuts[i]!, cuts[i + 1]!, highlights));
    }
    const block = blockRanges.get(run.block_index);
    const first = firstRunByBlock.get(run.block_index) === run;
    const classes = [className, first ? "cp-block" : ""].filter(Boolean).join(" ");
    const classAttribute = classes === "" ? "" : ` class="${classes}"`;
    const blockAttributes = first && block
      ? ` id="b${run.block_index}" data-cp-tag="${escape(block.tag)}"` +
        ` data-cp-start="${block.start}" data-cp-end="${block.end}"`
      : "";
    return `<span${classAttribute}${blockAttributes}` +
      ` data-cp-path="${escape(run.node_path)}" data-cp-start="${run.start}"` +
      ` data-cp-block="${run.block_index}">${content.join("")}</span>`;
  };

  const renderRuns = (path: string): string =>
    (runsByPath.get(path) ?? []).map((run) => renderRun(run)).join("");

  const renderNode = (node: Node, insideContent: boolean): string => {
    const path = pathOf(node, root);
    if (node.nodeType === 3) {
      // SAFETY: nodeType 3 identifies a DOM Text node.
      return renderRuns(path);
    }
    if (node.nodeType !== 1) return "";
    // SAFETY: nodeType 1 identifies a DOM Element node.
    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    if (tag === "head" || tag === "title") return "";
    if (tag === "img") {
      if (!includeNonContent && !insideContent) return "";
      return `<img${attributes(tag, element)}/>`;
    }
    if (tag === "br") {
      const runs = runsByPath.get(path) ?? [];
      return runs.map((run) => renderRun(run, "cp-break-text")).join("") +
        (runs.length === 0 ? "" : "<br/>");
    }
    if (tag === "hr") {
      return includeNonContent || insideContent ? "<hr/>" : "";
    }
    if (tag === "html" || tag === "body") {
      const bodyContent = tag === "body" &&
        (includeNonContent || insideContent || isPathContent(readable, path));
      return [...element.childNodes]
        .map((child) => renderNode(child, insideContent || bodyContent))
        .join("");
    }
    if (!STRUCTURED_TAGS.has(tag)) return "";

    const elementContent = insideContent || isPathContent(readable, path);
    const shouldRender = includeNonContent
      ? paths.has(path) || containsImage(element)
      : paths.has(path) || (elementContent && containsImage(element));
    if (!shouldRender) return "";

    const ownRuns = runsByPath.get(path) ?? [];
    let ownIndex = 0;
    const children: string[] = [];
    for (const child of element.childNodes) {
      const childPath = pathOf(child, root);
      const firstChildRun = (runsByPath.get(childPath) ?? [])[0];
      if (firstChildRun !== undefined) {
        while (
          ownIndex < ownRuns.length &&
          ownRuns[ownIndex]!.start < firstChildRun.start
        ) {
          children.push(renderRun(ownRuns[ownIndex]!));
          ownIndex += 1;
        }
      }
      children.push(renderNode(child, elementContent));
    }
    while (ownIndex < ownRuns.length) {
      children.push(renderRun(ownRuns[ownIndex]!));
      ownIndex += 1;
    }
    const inner = children.join("");
    if (tag === "table") {
      return `<div class="cp-table-wrap" role="region" tabindex="0" aria-label="Scrollable table">` +
        `<table${attributes(tag, element)}>${inner}</table></div>`;
    }
    if (tag === "wbr") return "<wbr/>";
    return `<${tag}${attributes(tag, element)}>${inner}</${tag}>`;
  };

  const body = document.body;
  const content = body === null
    ? ""
    : [...body.childNodes].map((node) => renderNode(node, false)).join("");
  return `<article class="cp-transcript">${content}</article>`;
}
