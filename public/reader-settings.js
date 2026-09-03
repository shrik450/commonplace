(() => {
  const root = document.documentElement;
  const reader = document.querySelector("[data-cp-reader]");
  const form = document.querySelector("[data-cp-settings-form]");
  if (!(form instanceof HTMLFormElement)) return;
  const attributes = new Map([
    ["font", "data-cp-font"],
    ["text_size", "data-cp-text-size"],
    ["line_spacing", "data-cp-line-spacing"],
    ["paragraph_spacing", "data-cp-paragraph-spacing"],
    ["text_width", "data-cp-text-width"],
  ]);
  const properties = new Map([
    ["text_size", ["--cp-text-size", (value) => `${value}px`]],
    ["line_spacing", ["--cp-line-spacing", (value) => String(Number(value) / 100)]],
    ["paragraph_spacing", ["--cp-paragraph-spacing", (value) => `${Number(value) / 100}em`]],
    ["text_width", ["--cp-text-width", (value) => `${value}ch`]],
  ]);
  const fields = ["theme", ...attributes.keys()];
  let saves = Promise.resolve();

  const apply = () => {
    for (const name of fields) {
      const field = form.elements.namedItem(name);
      if (!(field instanceof HTMLSelectElement || field instanceof HTMLInputElement)) continue;
      if (name === "theme") {
        if (field.value === "light") root.dataset.theme = "parchment";
        else if (field.value === "dark") root.dataset.theme = "ink";
        else delete root.dataset.theme;
      }
      if (reader) {
        const attribute = attributes.get(name);
        if (attribute) reader.setAttribute(attribute, field.value);
        const property = properties.get(name);
        if (property) reader.style.setProperty(property[0], property[1](field.value));
      }
      if (field instanceof HTMLInputElement && field.type === "range") {
        const output = field.closest("label")?.querySelector("[data-cp-range-output]");
        if (output) output.textContent = `${field.value}${output.dataset.cpUnit ?? ""}`;
      }
    }
  };

  form.addEventListener("input", apply);
  form.addEventListener("submit", (event) => {
    if (!window.fetch) return;
    event.preventDefault();
    const status = document.querySelector("[data-cp-settings-status]");
    const body = new URLSearchParams(new FormData(form));
    if (status) status.textContent = "Saving settings…";
    saves = saves.then(async () => {
      const response = await fetch(form.action, {
        method: "POST",
        headers: { Accept: "application/json" },
        body,
      });
      if (!response.ok) throw new Error("save failed");
      if (status) status.textContent = "Settings saved.";
    }).catch(() => {
      if (status) status.textContent = "Settings could not be saved. Submit the form again.";
    });
  });

  apply();
})();
