import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, test } from "bun:test";

import { asItemId, asUserId } from "../../src/contracts/ids";
import type { Item } from "../../src/contracts/item";
import { ReaderPageView } from "../../src/web/views/reader";

const SCRIPT = readFileSync(new URL("../../public/reader-settings.js", import.meta.url), "utf8");
const ITEM_ID = asItemId("11111111-1111-4111-8111-111111111111");
const USER_ID = asUserId("22222222-2222-4222-8222-222222222222");
const ITEM: Item = {
  id: ITEM_ID,
  user_id: USER_ID,
  url: "https://example.com/reader",
  title: "Reader title",
  author: null,
  created_at: "2026-01-01T00:00:00.000Z",
  ingested_at: "2026-01-01T00:00:00.000Z",
};
const SETTINGS = {
  user_id: USER_ID,
  theme: "auto" as const,
  font: "sans" as const,
  text_size: "medium" as const,
  line_spacing: "comfortable" as const,
  paragraph_spacing: "comfortable" as const,
  text_width: "comfortable" as const,
};

describe("reader settings preview", () => {
  test("uses the rendered reader structure for close and native summary behavior", () => {
    const rendered = String(ReaderPageView({
      item: ITEM,
      html: "<p>Reader content</p>",
      annotations: [],
      locale: "en-US",
      settings: SETTINGS,
      interactive: true,
    }));
    const dom = new JSDOM(`<!doctype html>${rendered}`, {
      runScripts: "outside-only",
      url: `http://localhost/items/${ITEM_ID}`,
    });

    dom.window.eval(SCRIPT);
    const document = dom.window.document;
    const close = document.querySelector("[data-cp-settings-details] > a");
    expect(close?.getAttribute("href")).toBe(`/items/${ITEM_ID}`);
    expect(close?.closest("form")).toBeNull();
    expect(document.querySelector("summary")?.hasAttribute("aria-expanded")).toBe(false);

    const textSize = document.querySelector<HTMLSelectElement>('select[name="text_size"]');
    expect(textSize).not.toBeNull();
    textSize!.value = "large";
    textSize!.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    expect(document.querySelector("[data-cp-reader]")?.getAttribute("data-cp-text-size")).toBe("large");
    dom.window.close();
  });
});
