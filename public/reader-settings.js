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
