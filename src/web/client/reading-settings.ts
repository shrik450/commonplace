// Previews reading settings as they change, and saves them without leaving
// the page. The form still saves with a normal submit when this doesn't run.

const READER_ATTRIBUTES = new Map([
  ["font", "data-cp-font"],
  ["text_size", "data-cp-text-size"],
  ["line_spacing", "data-cp-line-spacing"],
  ["paragraph_spacing", "data-cp-paragraph-spacing"],
  ["text_width", "data-cp-text-width"],
]);

const READER_PROPERTIES = new Map<string, [string, (value: string) => string]>([
  ["text_size", ["--cp-text-size", (value) => `${value}px`]],
  ["line_spacing", ["--cp-line-spacing", (value) => String(Number(value) / 100)]],
  ["paragraph_spacing", ["--cp-paragraph-spacing", (value) => `${Number(value) / 100}em`]],
  ["text_width", ["--cp-text-width", (value) => `${value}ch`]],
]);

// The page width follows the reading measure, so the whole desk previews too.
const PAGE_PROPERTIES = new Map([
  ["text_width", "--cp-measure"],
  ["text_size", "--cp-size"],
]);

const THEMES = new Map([["light", "parchment"], ["dark", "ink"]]);

export function enhanceReadingSettings(document: Document): void {
  const view = document.defaultView;
  const form = document.querySelector("[data-cp-settings-form]");
  if (view === null || !(form instanceof view.HTMLFormElement)) return;
  const reader = document.querySelector("[data-cp-reader]");
  const status = document.querySelector("[data-cp-settings-status]");
  const fields = ["theme", ...READER_ATTRIBUTES.keys()];
  let saves = Promise.resolve();

  const apply = () => {
    for (const name of fields) {
      const field = form.elements.namedItem(name);
      if (!(field instanceof view.HTMLSelectElement || field instanceof view.HTMLInputElement)) continue;
      const value = field.value;
      if (name === "theme") {
        const theme = THEMES.get(value);
        if (theme === undefined) delete document.documentElement.dataset.theme;
        else document.documentElement.dataset.theme = theme;
      }
      if (name === "font") document.body.dataset.cpFont = value;
      const pageProperty = PAGE_PROPERTIES.get(name);
      if (pageProperty !== undefined) document.body.style.setProperty(pageProperty, value);
      if (reader instanceof view.HTMLElement) {
        const attribute = READER_ATTRIBUTES.get(name);
        if (attribute !== undefined) reader.setAttribute(attribute, value);
        const property = READER_PROPERTIES.get(name);
        if (property !== undefined) reader.style.setProperty(property[0], property[1](value));
      }
      if (field instanceof view.HTMLInputElement && field.type === "range") {
        const output = field.closest("label")?.querySelector("[data-cp-range-output]");
        if (output instanceof view.HTMLElement) output.textContent = `${value}${output.dataset.cpUnit ?? ""}`;
      }
    }
  };

  form.addEventListener("input", apply);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const body = new URLSearchParams();
    for (const [name, value] of new view.FormData(form)) {
      if (!(value instanceof view.File)) body.append(name, value);
    }
    if (status !== null) status.textContent = "Saving settings…";
    saves = saves
      .then(async () => {
        const response = await view.fetch(form.action, { method: "POST", headers: { Accept: "application/json" }, body });
        if (!response.ok) throw new Error("save failed");
        if (status !== null) status.textContent = "Settings saved.";
      })
      .catch(() => {
        if (status !== null) status.textContent = "Settings could not be saved. Submit the form again.";
      });
  });

  apply();
}

// Tests import this module without a browser, and enhance a document of their own.
if ("document" in globalThis) enhanceReadingSettings(globalThis.document);
