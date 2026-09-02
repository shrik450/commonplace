import { AppError } from "../../contracts/errors";

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

// Validate tag and attribute names because the renderer inserts them without
// escaping. Invalid names could inject attributes or close a tag.
const NAME_PATTERN = /^[A-Za-z_:][\w.:-]*$/;

class HtmlNode {
  readonly #html: string;

  constructor(html: string) {
    this.#html = html;
  }

  toString(): string {
    return this.#html;
  }
}

export type { HtmlNode };

export const Fragment: unique symbol = Symbol("Fragment");

function renderChild(child: unknown): string {
  if (child === null || child === undefined || typeof child === "boolean") {
    return "";
  }
  if (child instanceof HtmlNode) return child.toString();
  if (Array.isArray(child)) return child.map(renderChild).join("");
  return Bun.escapeHTML(String(child));
}

function renderElement(
  tag: string,
  props: Record<string, unknown>,
): string {
  if (!NAME_PATTERN.test(tag)) {
    throw new AppError("VIEW_INVALID_TAG", `invalid tag name "${tag}"`, {
      tag,
    });
  }
  let attributes = "";
  for (const [name, value] of Object.entries(props)) {
    if (name === "children" || name === "key") continue;
    if (!NAME_PATTERN.test(name)) {
      throw new AppError(
        "VIEW_INVALID_ATTRIBUTE",
        `invalid attribute name "${name}"`,
        { name },
      );
    }
    if (value === false || value === null || value === undefined) continue;
    attributes +=
      value === true
        ? ` ${name}`
        : ` ${name}="${Bun.escapeHTML(String(value))}"`;
  }
  if (VOID_ELEMENTS.has(tag)) return `<${tag}${attributes}/>`;
  return `<${tag}${attributes}>${renderChild(props.children)}</${tag}>`;
}

export function jsx(
  type: string | typeof Fragment | ((props: never) => unknown),
  props: Record<string, unknown>,
): HtmlNode {
  if (type === Fragment) {
    return new HtmlNode(renderChild(props.children));
  }
  if (typeof type === "function") {
    const rendered = (type as (props: unknown) => unknown)(props);
    // `renderChild` handles a component result, including arrays and empty values.
    return new HtmlNode(renderChild(rendered));
  }
  return new HtmlNode(renderElement(type, props));
}

export const jsxs = jsx;

export function raw(html: string): HtmlNode {
  return new HtmlNode(html);
}

export namespace JSX {
  export type Element = HtmlNode;
  export interface IntrinsicElements {
    [element: string]: {
      [attribute: string]: unknown;
      children?: unknown;
    };
  }
  export interface ElementChildrenAttribute {
    children: unknown;
  }
}
