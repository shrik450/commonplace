import { fetchPage, submitInPlace } from "./submit";

function changed(field: HTMLTextAreaElement): boolean {
  return field.value.trim() !== field.defaultValue.trim();
}

// Writes a note on the book's entry itself: a clipping's note, or a page
// note. Without this script the edit link leads to the entry's own page,
// which has the same form. `relaid` tells the book that an entry changed size
// or was replaced, and which entry to stay open at.
export function enhanceClippingNotes(flow: HTMLElement, relaid: (anchor: Element | null) => void): void {
  const document = flow.ownerDocument;
  const view = document.defaultView;
  const template = document.querySelector("template[data-note-editor]");
  const status = document.querySelector("[data-note-status]");
  if (view === null || !(template instanceof view.HTMLTemplateElement) || !(status instanceof view.HTMLElement)) return;

  const scrapOf = (element: Element): HTMLElement | null => {
    const scrap = element.closest("[data-clipping], [data-page-note]");
    return scrap instanceof view.HTMLElement ? scrap : null;
  };
  const selectorOf = (scrap: HTMLElement): string => scrap.dataset.clipping === undefined
    ? `[data-page-note="${view.CSS.escape(scrap.dataset.pageNote ?? "")}"]`
    : `[data-clipping="${view.CSS.escape(scrap.dataset.clipping)}"]`;
  const fieldOf = (scope: Element): HTMLTextAreaElement | null => {
    const field = scope.querySelector("[data-note-editor-form] textarea");
    return field instanceof view.HTMLTextAreaElement ? field : null;
  };

  const open = (link: HTMLAnchorElement) => {
    const scrap = scrapOf(link);
    const form = template.content.firstElementChild?.cloneNode(true);
    if (scrap === null || scrap.dataset.editing !== undefined || !(form instanceof view.HTMLFormElement)) return;
    const field = fieldOf(form);
    const remove = form.querySelector("[data-note-remove]");
    if (field === null || !(remove instanceof view.HTMLAnchorElement)) return;
    form.action = link.href;
    remove.href = `${link.href}/delete`;
    if (link.dataset.removeLabel !== undefined) remove.textContent = link.dataset.removeLabel;
    field.defaultValue = scrap.querySelector("[data-note-text]")?.textContent ?? "";
    link.closest("footer")?.before(form);
    scrap.dataset.editing = "";
    relaid(scrap);
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  };

  const close = (scrap: HTMLElement) => {
    scrap.querySelector("[data-note-editor-form]")?.remove();
    delete scrap.dataset.editing;
    relaid(scrap);
    const link = scrap.querySelector("[data-note-edit]");
    if (link instanceof view.HTMLElement) link.focus();
  };

  // The saved entry is drawn by the server, like every other: the book's
  // current view is fetched again and the entry taken from it. An entry the
  // view no longer holds, such as a clipping whose note was cleared in "With
  // notes", means the view itself changed, so all of it is replaced.
  const redraw = async (scrap: HTMLElement): Promise<string | null> => {
    const answer = await fetchPage(view, view.location.href);
    const fresh = answer.kind === "accepted" ? answer.page.querySelector("[data-flow]") : null;
    if (fresh === null) return "The note is saved, but the book couldn't be redrawn. Reload the page to see it.";
    const redrawn = fresh.querySelector(selectorOf(scrap));
    if (redrawn === null) {
      flow.replaceChildren(...[...fresh.children].map((child) => document.adoptNode(child)));
      relaid(null);
      return null;
    }
    const kept = document.adoptNode(redrawn);
    scrap.replaceWith(kept);
    relaid(kept);
    const link = kept.querySelector("[data-note-edit]");
    if (link instanceof view.HTMLElement) link.focus();
    return null;
  };

  const save = async (form: HTMLFormElement) => {
    const scrap = scrapOf(form);
    const field = fieldOf(form);
    const label = form.querySelector("[data-note-label]");
    const error = form.querySelector("[data-note-error]");
    if (scrap === null || field === null || label === null || !(error instanceof view.HTMLElement)) return;
    if (form.dataset.saving !== undefined) return;
    form.dataset.saving = "";
    const idle = label.textContent;
    label.textContent = "Saving…";
    const answer = await submitInPlace(view, form.action, new URLSearchParams({ note: field.value }));
    const problem = answer.kind === "refused" ? answer.message : await redraw(scrap);
    delete form.dataset.saving;
    label.textContent = idle;
    if (problem === null) {
      status.textContent = field.value.trim() === "" ? "Note removed." : "Note saved.";
      return;
    }
    error.textContent = problem;
    error.hidden = false;
    relaid(scrap);
  };

  flow.addEventListener("click", (event) => {
    if (!(event.target instanceof view.Element)) return;
    const link = event.target.closest("[data-note-edit]");
    // A modified click opens the clipping's own page, as any link would.
    if (link instanceof view.HTMLAnchorElement && !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) {
      event.preventDefault();
      open(link);
      return;
    }
    const scrap = event.target.closest("[data-note-cancel]") === null ? null : scrapOf(event.target);
    if (scrap !== null) close(scrap);
  });
  flow.addEventListener("submit", (event) => {
    if (!(event.target instanceof view.HTMLFormElement) || !event.target.matches("[data-note-editor-form]")) return;
    event.preventDefault();
    void save(event.target);
  });
  flow.addEventListener("keydown", (event) => {
    const field = event.target;
    if (!(field instanceof view.HTMLTextAreaElement) || field.form === null) return;
    // Escape puts away an untouched note. Edits are only thrown away on
    // purpose, with Cancel.
    const scrap = event.key === "Escape" && !changed(field) ? scrapOf(field) : null;
    if (scrap !== null) close(scrap);
  });
  view.addEventListener("beforeunload", (event) => {
    const fields = [...flow.querySelectorAll("[data-note-editor-form] textarea")];
    if (fields.some((field) => field instanceof view.HTMLTextAreaElement && changed(field))) event.preventDefault();
  });
}
