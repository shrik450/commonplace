// The header's save card is a `<details>` element, so it opens and closes on
// its own. This adds what a dropped card should do: focus its field when it
// opens, and close on Escape or a click elsewhere.
export function enhanceSaveCard(document: Document): void {
  const view = document.defaultView;
  const drop = document.querySelector("[data-save-drop]");
  if (view === null || !(drop instanceof view.HTMLDetailsElement)) return;
  const field = drop.querySelector("input");
  const summary = drop.querySelector("summary");

  drop.addEventListener("toggle", () => {
    if (drop.open) field?.focus();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !drop.open) return;
    drop.open = false;
    summary?.focus();
  });
  document.addEventListener("click", (event) => {
    if (drop.open && event.target instanceof view.Node && !drop.contains(event.target)) drop.open = false;
  });
}

if ("document" in globalThis) enhanceSaveCard(globalThis.document);
