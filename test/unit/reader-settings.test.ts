import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, test } from "bun:test";

import { asUserId } from "../../src/contracts/ids";
import { SettingsPage } from "../../src/web/views/settings";

const SCRIPT = readFileSync(new URL("../../public/reader-settings.js", import.meta.url), "utf8");
const USER_ID = asUserId("22222222-2222-4222-8222-222222222222");
const SETTINGS = {
  user_id: USER_ID,
  theme: "auto" as const,
  font: "system-sans" as const,
  text_size: 18,
  line_spacing: 170,
  paragraph_spacing: 90,
  text_width: 68,
};

describe("reader settings preview", () => {
  test("updates the sample and numeric label from each slider", () => {
    const rendered = String(SettingsPage({
      tokens: [],
      locale: "en-US",
      settings: SETTINGS,
    }));
    const dom = new JSDOM(`<!doctype html>${rendered}`, {
      runScripts: "outside-only",
      url: "http://localhost/settings",
    });

    dom.window.eval(SCRIPT);
    const document = dom.window.document;
    const textSize = document.querySelector<HTMLInputElement>('input[name="text_size"]');
    expect(textSize?.type).toBe("range");
    textSize!.value = "22";
    textSize!.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    expect(document.querySelector("[data-cp-reader]")?.getAttribute("data-cp-text-size")).toBe("22");
    expect(document.querySelector("[data-cp-reader]")?.getAttribute("style")).toContain("--cp-text-size: 22px");
    expect(document.querySelector("[data-cp-range-output]")?.textContent).toBe("22 px");
    dom.window.close();
  });
});
