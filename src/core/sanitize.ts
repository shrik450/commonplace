import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";

import { AppError } from "../contracts/errors";

const BLOCK = [
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

export const ALLOWED_TAGS = ["html", "head", "title", "body", ...BLOCK, ...INLINE];

const CONFIG = {
  ALLOWED_TAGS,
  ALLOWED_ATTR: ["id","class","href","src","alt","title","lang","dir","colspan","rowspan","datetime","width","height"],
  WHOLE_DOCUMENT: true,
  KEEP_CONTENT: true,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};

const purifier = createDOMPurify(
  new JSDOM("").window as unknown as Parameters<typeof createDOMPurify>[0],
);

export function sanitize(html: string): string {
  if (typeof html !== "string" || html.trim() === "") {
    throw new AppError("WALK_UNPARSEABLE", "the input is not parseable HTML");
  }
  return `<!DOCTYPE html>\n${purifier.sanitize(html, CONFIG)}`;
}
