import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import { AppError } from "../../src/contracts/errors";
import { Fragment, jsx, raw } from "../../src/web/views/jsx-runtime";

const TextComponent = () => "<script>";
const RawComponent = () => jsx("div", { children: raw("<b>safe boundary</b>") });

function codeOf(run: () => void): string {
  try {
    run();
  } catch (error) {
    return error instanceof AppError ? error.code : "";
  }
  return "";
}

describe("HTML rendering", () => {
  test("escapes text and attribute values", () => {
    const html = String(jsx("p", {
      title: `"'><script>`,
      children: `& <script>alert(1)</script>`,
    }));
    const document = new JSDOM(html).window.document;
    expect(document.querySelector("p")?.getAttribute("title")).toBe("\"'><script>");
    expect(document.querySelector("p")?.textContent).toBe("& <script>alert(1)</script>");
    expect(html).not.toContain("<script>alert");
  });

  test("rejects tag and attribute names that could inject markup", () => {
    expect(codeOf(() => jsx("div><script>", {}))).toBe("VIEW_INVALID_TAG");
    expect(codeOf(() => jsx("div", { "x onerror=alert(1)": true }))).toBe("VIEW_INVALID_ATTRIBUTE");
  });

  test("escapes strings returned by components but preserves explicit raw HTML", () => {
    const escaped = String(jsx(TextComponent, {}));
    expect(new JSDOM(escaped).window.document.body.textContent).toBe("<script>");
    expect(escaped).not.toContain("<script>");
    const page = new JSDOM(String(jsx(RawComponent, {}))).window.document;
    expect(page.querySelector("div > b")?.textContent).toBe("safe boundary");
  });

  test("renders fragments, arrays, and void elements without closing tags", () => {
    const html = String(jsx(Fragment, {
      children: [jsx("input", { disabled: true }), jsx("br", {})],
    }));
    const document = new JSDOM(html).window.document;
    expect(document.querySelector("input")?.hasAttribute("disabled")).toBe(true);
    expect(document.querySelector("br")).not.toBeNull();
    expect(html).not.toContain("</input>");
  });
});
