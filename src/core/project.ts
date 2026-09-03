import { JSDOM } from "jsdom";

import type { AnnotationId } from "../contracts/ids";
import { blocksOf, type Run, type TranscriptMap } from "../contracts/transcript";
import { BLOCK_ELEMENTS } from "./sanitize";

export type Highlight = { id: AnnotationId; start: number; end: number };

export type ProjectInput = {
  sanitizedHtml: string;
  transcript: string;
  map: TranscriptMap;
  highlights?: Highlight[];
};

const BLOCK_SET = new Set<string>(BLOCK_ELEMENTS);

// Preserve tags with useful reader semantics. Render other blocks as
// paragraphs, and retain their source tag in `data-cp-tag` for styling.
const KEPT_TAGS = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
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

// Finds the nearest block ancestor of the node that produced a run.
function ownerTag(root: Element, path: string): string {
  let node = nodeAt(root, path);
  while (node) {
    if (node.nodeType === 1) {
      const tag = (node as Element).tagName.toLowerCase();
      if (BLOCK_SET.has(tag)) return tag;
    }
    node = node.parentNode;
  }
  return "p";
}


function usable(highlights: Highlight[], length: number): Highlight[] {
  return highlights.filter(
    (highlight) =>
      highlight.end > highlight.start &&
      highlight.start < length &&
      highlight.end > 0,
  );
}

// Splits a run at each highlight boundary.
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

// Renders content runs with text from the transcript and block tags from the
// sanitized DOM. Using transcript text preserves exact highlight ranges.
export function project(input: ProjectInput): string {
  const { sanitizedHtml, transcript, map } = input;
  const highlights = usable(input.highlights ?? [], transcript.length);
  const root = new JSDOM(sanitizedHtml).window.document.documentElement;

  const parts: string[] = ['<article class="cp-transcript">'];
  for (const transcriptBlock of blocksOf(map).filter(
    (candidate) => candidate.runs[0]!.is_content,
  )) {
    const start = transcriptBlock.runs[0]!.start;
    const end = transcriptBlock.runs[transcriptBlock.runs.length - 1]!.end;
    const tag = ownerTag(root, transcriptBlock.runs[0]!.node_path);
    const rendered = KEPT_TAGS.has(tag) ? tag : "p";

    parts.push(
      `<${rendered} class="cp-block" data-cp-tag="${escape(tag)}"` +
        ` data-cp-block="${transcriptBlock.index}"` +
        ` data-cp-start="${start}" data-cp-end="${end}">`,
    );
    for (const run of transcriptBlock.runs) {
      parts.push(
        `<span data-cp-path="${escape(run.node_path)}" data-cp-start="${run.start}">`,
      );
      const cuts = cutsIn(run, highlights);
      for (let i = 0; i < cuts.length - 1; i += 1) {
        parts.push(piece(transcript, cuts[i]!, cuts[i + 1]!, highlights));
      }
      parts.push("</span>");
    }
    parts.push(`</${rendered}>`);
  }
  parts.push("</article>");
  return parts.join("");
}
