import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";

import { AppError } from "../contracts/errors";

// The walker and sanitizer must agree on which elements start a block.
export const BLOCK_ELEMENTS: string[] = [
  "address", "article", "aside", "blockquote", "caption", "dd", "details",
  "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "h1",
  "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "li", "main",
  "nav", "ol", "p", "pre", "section", "summary", "table", "tbody", "td",
  "tfoot", "th", "thead", "tr", "ul",
];

const INLINE = [
  "a",
  "em",
  "strong",
  "i",
  "b",
  "u",
  "s",
  "code",
  "kbd",
  "samp",
  "var",
  "span",
  "br",
  "img",
  "q",
  "cite",
  "time",
  "sub",
  "sup",
  "small",
  "mark",
  "abbr",
  "del",
  "ins",
  "wbr",
  "noscript",
  "bdi",
  "bdo",
];

export const ALLOWED_TAGS: string[] = [
  "html",
  "head",
  "title",
  "body",
  ...BLOCK_ELEMENTS,
  ...INLINE,
];

const CONFIG = {
  ALLOWED_TAGS,
  ALLOWED_ATTR: ["id","class","href","src","alt","title","lang","dir","colspan","rowspan","datetime","width","height"],
  WHOLE_DOCUMENT: true,
  KEEP_CONTENT: true,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};

const purifierWindow = new JSDOM("").window;
// SAFETY: jsdom's window implements the DOMPurify window interface.
const purifier = createDOMPurify(
  purifierWindow as Parameters<typeof createDOMPurify>[0],
);

export function sanitize(html: string): string {
  if (html.trim() === "") {
    throw new AppError("WALK_UNPARSEABLE", "the HTML input is empty");
  }
  return `<!DOCTYPE html>\n${purifier.sanitize(html, CONFIG)}`;
}
