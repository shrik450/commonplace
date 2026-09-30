import { SUBMIT } from "../views/controls";

// Ctrl or Cmd+Enter in a note sends its form with the form's primary button,
// the one action the page is for. Enter alone still starts a new line. A
// form a script takes over, such as the clipping slip, hears the submission
// like any other.
export function enhanceSubmitShortcut(document: Document): void {
  const view = document.defaultView;
  if (view === null) return;
  const isPrimary = (element: Element): element is HTMLButtonElement =>
    element instanceof view.HTMLButtonElement && element.type === "submit" && element.classList.contains(SUBMIT);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
    const field = event.target;
    if (!(field instanceof view.HTMLTextAreaElement) || field.form === null) return;
    event.preventDefault();
    field.form.requestSubmit([...field.form.elements].find(isPrimary) ?? null);
  });
}

if ("document" in globalThis) enhanceSubmitShortcut(globalThis.document);
