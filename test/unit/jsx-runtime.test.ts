import { describe, expect, test } from "bun:test";
import { Fragment, jsx, jsxs, raw } from "../../src/web/views/jsx-runtime";
import { AppError, isAppError } from "../../src/contracts/errors";

describe("jsx-runtime attribute and tag validation", () => {
  test("rejects an attribute name that smuggles in script handlers", () => {
    const evil = { "x onerror=alert(1) y": true };
    let error: unknown;
    try {
      String(jsx("img", { src: "z", ...evil }));
    } catch (caught) {
      error = caught;
    }
    expect(isAppError(error)).toBe(true);
    expect((error as AppError).code).toBe("VIEW_INVALID_ATTRIBUTE");
    expect((error as AppError).context.name).toBe("x onerror=alert(1) y");
  });

  test("rejects an attribute name that breaks out of the tag", () => {
    let error: unknown;
    try {
      String(jsx("div", { "a=><script>alert(1)</script>": true }));
    } catch (caught) {
      error = caught;
    }
    expect(isAppError(error)).toBe(true);
    expect((error as AppError).code).toBe("VIEW_INVALID_ATTRIBUTE");
  });

  test("rejects an invalid tag name", () => {
    let error: unknown;
    try {
      String(jsx("div><script>", {}));
    } catch (caught) {
      error = caught;
    }
    expect(isAppError(error)).toBe(true);
    expect((error as AppError).code).toBe("VIEW_INVALID_TAG");
  });

  test("still allows plain, hyphenated, and namespaced names", () => {
    const html = String(
      jsx("my-widget", {
        "data-start": "0",
        "aria-label": "ok",
        "xlink:href": "/a",
      }),
    );
    expect(html).toContain('data-start="0"');
    expect(html).toContain('aria-label="ok"');
    expect(html).toContain('xlink:href="/a"');
  });
});

const List = () => [
  jsx("li", { children: "a" }),
  jsx("li", { children: "b" }),
];

const Empty = () => null;

const Word = () => "<script>";

describe("jsx-runtime function component results", () => {
  test("renders a component that returns an array", () => {
    expect(String(jsx(List, {}))).toBe("<li>a</li><li>b</li>");
  });

  test("renders a component that returns null as nothing", () => {
    expect(String(jsx(Empty, {}))).toBe("");
  });

  test("still escapes a raw string a component returns", () => {
    expect(String(jsx(Word, {}))).toBe("&lt;script&gt;");
  });
});

describe("jsx-runtime attributes", () => {
  test("a true attribute renders as the bare name", () => {
    expect(String(jsx("input", { type: "text", disabled: true }))).toBe(
      "<input type=\"text\" disabled/>",
    );
  });

  test("false, null, and undefined attributes are left out", () => {
    expect(
      String(jsx("input", { type: "text", disabled: false, "data-a": null, "data-b": undefined })),
    ).toBe('<input type="text"/>');
  });

  test("number children render", () => {
    expect(String(jsx("span", { children: 42 }))).toBe("<span>42</span>");
  });
});

const Page = () => jsx("div", { children: raw("<b>x</b>") });

describe("jsx-runtime raw", () => {
  test("raw at the top level passes through", () => {
    expect(String(raw("<hr/>"))).toBe("<hr/>");
  });

  test("raw inside a component passes through", () => {
    expect(String(jsx(Page, {}))).toBe("<div><b>x</b></div>");
  });
});

describe("jsx-runtime fragments and voids", () => {
  test("a fragment with one child renders the child alone", () => {
    expect(String(jsx(Fragment, { children: jsx("p", { children: "x" }) }))).toBe(
      "<p>x</p>",
    );
  });

  test("nested void elements never get closing tags", () => {
    const out = String(
      jsxs("div", {
        children: [jsx("br", {}), jsx("img", { src: "/a.png" })],
      }),
    );
    expect(out).toBe('<div><br/><img src="/a.png"/></div>');
  });
});
