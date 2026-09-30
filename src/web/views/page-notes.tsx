import { NOTE_MAX_LENGTH } from "../../contracts/clipping";
import type { Item, PageNote } from "../../contracts/item";
import type { NotedPage } from "../../services/page-notes";
import { ACTION, FIELD, LINK, SUBMIT } from "./controls";
import { readableDate } from "./format";
import { PenIcon } from "./icons";
import { Layout, type PageContext } from "./layout";
import { Sheet } from "./sheet";

const PLACEHOLDER = "What this page left you with, in a line or two…";

// The end of the reader's sheet: your notes on the page as a whole, and the
// form for another. It is written below the text, never beside it.
export function PageNotesSection({ item, notes, locale }: { item: Item; notes: PageNote[]; locale: string }) {
  return (
    <section id="page-notes" class="page-notes" aria-labelledby="page-notes-title">
      <h2 id="page-notes-title" class="page-notes-title">Notes on this page</h2>
      {notes.length === 0 ? null : (
        <ol class="page-notes-list">
          {notes.map((note) => (
            <li class="page-notes-entry" data-page-note={note.id}>
              <p class="page-notes-body"><PenIcon /><span>{note.body}</span></p>
              <p class="page-notes-foot">
                <time datetime={note.created_at}>{readableDate(note.created_at, locale)}</time>
                {" · "}
                <a class={LINK} href={`/page-notes/${note.id}`}>Edit note</a>
              </p>
            </li>
          ))}
        </ol>
      )}
      <form class="page-notes-form" method="post" action={`/items/${item.id}/page-notes`}>
        <label for="page-note">{notes.length === 0 ? "Write a note on this page" : "Add another note"}</label>
        <textarea
          id="page-note"
          class={FIELD}
          name="note"
          rows="3"
          required
          maxlength={NOTE_MAX_LENGTH}
          autocomplete="off"
          placeholder={PLACEHOLDER}
        ></textarea>
        <p><button type="submit" class={SUBMIT}>Save note</button></p>
      </form>
    </section>
  );
}

function readerHref(item: Item): string {
  return `/items/${item.id}#page-notes`;
}

export function PageNotePage({ noted, context }: { noted: NotedPage; context: PageContext }) {
  const { note, item } = noted;
  const path = `/page-notes/${note.id}`;
  return (
    <Layout title="Page note" context={context}>
      <Sheet labelledBy="page-note-title" narrow>
        <p class="sheet-kicker">Note on</p>
        <h1 id="page-note-title" class="sheet-title"><a class={LINK} href={`/items/${item.id}`}>{item.title}</a></h1>
        <form class="note-form" action={path} method="post">
          <label for="note">Your note</label>
          <textarea id="note" name="note" class={FIELD} rows="5" required maxlength={NOTE_MAX_LENGTH} autocomplete="off" placeholder={PLACEHOLDER}>{note.body}</textarea>
          <p class="sheet-actions">
            <button type="submit" class={SUBMIT}>Save note</button>
            <a class={ACTION} href={readerHref(item)}>Back to the page</a>
          </p>
        </form>
        <p class="sheet-note">
          Written <time datetime={note.created_at}>{readableDate(note.created_at, context.locale)}</time>
          {" · "}
          <a class={LINK} href={`${path}/delete`}>Remove note…</a>
        </p>
      </Sheet>
    </Layout>
  );
}

export function RemovePageNotePage({ noted, context }: { noted: NotedPage; context: PageContext }) {
  const { note, item } = noted;
  const path = `/page-notes/${note.id}`;
  return (
    <Layout title="Remove note" context={context}>
      <Sheet labelledBy="remove-title" narrow>
        <h1 id="remove-title" class="sheet-title">Remove this note from “{item.title}”?</h1>
        <p class="sheet-quote page-notes-body"><PenIcon /><span>{note.body}</span></p>
        <p class="sheet-lede">
          The note leaves the page and your commonplace book. The page and its clippings stay. You can’t undo this.
        </p>
        <div class="sheet-actions">
          <form action={`${path}/delete`} method="post">
            <button type="submit" class={SUBMIT}>Remove note</button>
          </form>
          <a class={ACTION} href={path}>Cancel</a>
        </div>
      </Sheet>
    </Layout>
  );
}
