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
export type Child = HtmlNode | Child[] | string | number | boolean | null | undefined;
type AttributeProps = { readonly [key: string]: Child };
type FragmentProps = { readonly children?: Child };

type Component<P> = (props: P) => Child;

export const Fragment: unique symbol = Symbol("Fragment");

function renderChild(child: Child): string {
  if (child === null || child === undefined || child === true || child === false) {
    return "";
  }
  if (child instanceof HtmlNode) return child.toString();
  if (Array.isArray(child)) return child.map(renderChild).join("");
  return Bun.escapeHTML(String(child));
}

function renderElement(tag: string, props: AttributeProps): string {
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

type JsxArguments<P> =
  | [type: typeof Fragment, props: FragmentProps]
  | [type: string, props: AttributeProps]
  | [type: Component<P>, props: P];

function isComponentCall<P>(
  args: JsxArguments<P>,
): args is [type: Component<P>, props: P] {
  return typeof args[0] === "function";
}

export function jsx(type: typeof Fragment, props: FragmentProps): HtmlNode;
export function jsx(type: string, props: AttributeProps): HtmlNode;
export function jsx<P>(type: Component<P>, props: P): HtmlNode;
export function jsx<P>(...args: JsxArguments<P>): HtmlNode {
  if (args[0] === Fragment) {
    return new HtmlNode(renderChild(args[1].children));
  }
  if (isComponentCall(args)) {
    return new HtmlNode(renderChild(args[0](args[1])));
  }
  return new HtmlNode(renderElement(args[0], args[1]));
}

export const jsxs = jsx;

export function raw(html: string): HtmlNode {
  return new HtmlNode(html);
}

export namespace JSX {
  export type Element = HtmlNode;
  export interface IntrinsicElements {
    [element: string]: AttributeProps;
  }
  export interface ElementChildrenAttribute {
    children: Child;
  }
}
