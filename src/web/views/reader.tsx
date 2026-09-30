import { NOTE_MAX_LENGTH } from "../../contracts/clipping";
import type { Annotation, Item } from "../../contracts/item";
import type { ProjectionMode } from "../../core/project";
import { ACTION, FIELD, LINK, SUBMIT } from "./controls";
import { counted, hostOf, readableDate } from "./format";
import { PenIcon, ScissorsIcon } from "./icons";
import { raw } from "./jsx-runtime";
import { Layout, type PageContext } from "./layout";
import { SheetBacking } from "./sheet";

export type ReaderProps = {
  item: Item;
  html: string;
  annotations: Annotation[];
  mode: ProjectionMode;
  context: PageContext;
};

// The form a selection submits. `clip.js` fills the offsets, shows the pop-up
// and the note slip, and submits in place; without a script the form stays
// hidden, because selecting text is a browser interaction.
function ClipForm({ item }: { item: Item }) {
  return (
    <>
      <form id="clip-form" method="post" action={`/items/${item.id}/clippings`} hidden data-clip-form>
        <input type="hidden" name="start" value="" />
        <input type="hidden" name="end" value="" />
      </form>
      <div class="clip-pop" role="toolbar" aria-label="Clip the selection" hidden data-clip-pop>
        <button type="submit" form="clip-form">
          <ScissorsIcon size={14} /><span data-clip-label>Clip it</span>
        </button>
        <button type="button" data-clip-open-note>
          <PenIcon size={14} />Add a note
        </button>
      </div>
      <div class="clip-slip" role="group" aria-labelledby="clip-note-label" hidden data-clip-slip>
        <label id="clip-note-label" for="clip-note">Note on this clipping</label>
        <textarea
          id="clip-note"
          class={FIELD}
          name="note"
          form="clip-form"
          rows="3"
          maxlength={NOTE_MAX_LENGTH}
          autocomplete="off"
          placeholder="Why this passage matters, in a line or two…"
        ></textarea>
        <p class="clip-slip-error" role="alert" hidden data-clip-error />
        <div class="clip-slip-actions">
          <button type="submit" form="clip-form" class={SUBMIT}><span data-clip-label>Save clipping</span></button>
          <button type="button" class={ACTION} data-clip-cancel>Cancel</button>
        </div>
      </div>
      <p class="sr-only" role="status" data-clip-status />
    </>
  );
}

export function ReaderPageView({ item, html, annotations, mode, context }: ReaderProps) {
  const host = hostOf(item.url);
  const { settings } = context;
  const reading = mode === "reader";
  return (
    <Layout title={item.title} context={context} scripts={reading ? ["clip"] : []}>
      <div
        class="reader"
        data-cp-reader
        data-cp-font={settings.font}
        data-cp-text-size={settings.text_size}
        data-cp-line-spacing={settings.line_spacing}
        data-cp-paragraph-spacing={settings.paragraph_spacing}
        data-cp-text-width={settings.text_width}
        style={`--cp-text-size: ${settings.text_size}px; --cp-line-spacing: ${settings.line_spacing / 100}; --cp-paragraph-spacing: ${settings.paragraph_spacing / 100}em; --cp-text-width: ${settings.text_width}ch`}
      >
        <SheetBacking />
        <article class="sheet sheet-folded reader-sheet" aria-labelledby="reader-title">
          <span class="sheet-fold" aria-hidden="true" />
          {annotations.length === 0 ? null : (
            <a
              class="ribbon"
              href={`/clippings?item=${item.id}`}
              aria-label={`${counted(annotations.length, "clipping", "clippings")} from this page`}
            >
              <span class="ribbon-cloth">{String(annotations.length)}</span>
            </a>
          )}
          <nav class="kicker" aria-label="Other views of this page">
            <a class={LINK} href="/library">← Library</a>
            {reading
              ? <a class={LINK} href={`/items/${item.id}/raw`}>Structured text</a>
              : <a class={LINK} href={`/items/${item.id}`}>Reader</a>}
            <a class={LINK} href={`/items/${item.id}/capture`}>Saved copy</a>
            <a class={LINK} href={item.url} rel="noreferrer">Original page ↗</a>
          </nav>
          <h1 id="reader-title" class="reader-title">{item.title}</h1>
          <p class="byline">
            {[item.author, host].filter((part) => part !== null && part !== "").join(" · ")}
            {item.author === null && host === null ? "" : " · "}
            <time datetime={item.created_at}>{readableDate(item.created_at, context.locale)}</time>
            {reading ? null : " · Structured text, including the parts outside the article"}
          </p>
          {/* The projection comes from the archived page rather than this interface. */}
          <div class="reader-text" data-cp-projected>{raw(html)}</div>
        </article>
        {reading ? <ClipForm item={item} /> : null}
      </div>
    </Layout>
  );
}
