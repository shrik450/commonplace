import { JSDOM } from "jsdom";
import { describe, expect, test } from "bun:test";

import { asUserId } from "../../src/contracts/ids";
import { enhanceReadingSettings } from "../../src/web/client/reading-settings";
import { SettingsPage } from "../../src/web/views/settings";

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

function settingsDocument(): JSDOM {
  const rendered = String(SettingsPage({
    tokens: [],
    context: { settings: SETTINGS, locale: "en-US", cardCount: 0, today: new Date("2026-09-01T00:00:00.000Z") },
  }));
  return new JSDOM(`<!doctype html>${rendered}`, { url: "http://localhost/settings" });
}

function change(dom: JSDOM, name: string, value: string): void {
  const field = dom.window.document.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)!;
  field.value = value;
  field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}

describe("reading settings preview", () => {
  test("updates the sample and numeric label from each slider", () => {
    const dom = settingsDocument();
    enhanceReadingSettings(dom.window.document);
    const document = dom.window.document;
    change(dom, "text_size", "22");
    expect(document.querySelector("[data-cp-reader]")?.getAttribute("data-cp-text-size")).toBe("22");
    expect(document.querySelector("[data-cp-reader]")?.getAttribute("style")).toContain("--cp-text-size: 22px");
    expect(document.querySelector("[data-cp-range-output]")?.textContent).toBe("22 px");
    dom.window.close();
  });

  test("previews the theme, font, and page width across the whole page", () => {
    const dom = settingsDocument();
    enhanceReadingSettings(dom.window.document);
    const document = dom.window.document;
    change(dom, "theme", "dark");
    expect(document.documentElement.dataset.theme).toBe("ink");
    change(dom, "theme", "auto");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    change(dom, "font", "literata");
    expect(document.body.dataset.cpFont).toBe("literata");
    change(dom, "text_width", "80");
    expect(document.body.style.getPropertyValue("--cp-measure")).toBe("80");
    expect(document.querySelector("[data-cp-reader]")?.getAttribute("style")).toContain("--cp-text-width: 80ch");
    dom.window.close();
  });
});
