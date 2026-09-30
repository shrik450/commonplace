import { formatCursor, type Cursor } from "../../contracts/cursor";
import { NOTE_MAX_LENGTH } from "../../contracts/clipping";
import type { Annotation, Item } from "../../contracts/item";
import type { Book, BookFilter, Clipping, Locus } from "../../services/clippings";
import { ACTION, FIELD, LINK, SUBMIT } from "./controls";
import { counted, hostOf, monthOf, readableDate, variantOf } from "./format";
import { Paperclip, PenIcon } from "./icons";
import { Layout, type PageContext } from "./layout";
import { Sheet } from "./sheet";

// A torn edge and a fastener per clipping, chosen from its ID so a scrap looks
// the same on every visit. `book.css` draws each variant.
const EDGE_VARIANTS = 6;

export type BookView = "by-page" | "notes" | "shuffle";

export function viewOf(filter: BookFilter): BookView {
  if (filter.order.kind === "shuffle") return "shuffle";
  return filter.notesOnly ? "notes" : "by-page";
}

type BookLink = { view: BookView; itemId: Item["id"] | null; seed: number; before?: Cursor; after?: Cursor };

function bookHref(link: BookLink): string {
  const params = new URLSearchParams();
  if (link.before !== undefined) params.set("before", formatCursor(link.before));
  if (link.after !== undefined) params.set("after", formatCursor(link.after));
  if (link.itemId !== null) params.set("item", link.itemId);
  if (link.view === "notes") params.set("notes", "1");
  if (link.view === "shuffle") {
    params.set("order", "shuffle");
    params.set("seed", String(link.seed));
  }
  const query = params.toString();
  return query === "" ? "/clippings" : `/clippings?${query}`;
}

function ClippingScrap({ clipping, locale }: { clipping: Annotation; locale: string }) {
  const clipped = variantOf(`${clipping.id}:fastener`, 3) === 1;
  return (
    <figure class="clipping" data-edge={variantOf(clipping.id, EDGE_VARIANTS)} data-fastener={clipped ? "clip" : "tape"}>
      {clipped ? <Paperclip /> : <span class="tape" aria-hidden="true" />}
      <div class="clipping-paper">
        <blockquote class="clipping-quote"><span class="wash">{clipping.quote}</span></blockquote>
        {clipping.note === null ? null : (
          <p class="clipping-note"><PenIcon />{clipping.note}</p>
        )}
        <footer class="clipping-foot">
          <time datetime={clipping.created_at}>{readableDate(clipping.created_at, locale)}</time>
          <a class={LINK} href={`/clippings/${clipping.id}`}>{clipping.note === null ? "Add a note" : "Edit note"}</a>
        </footer>
      </div>
    </figure>
  );
}

function LocusSection({ locus, locale, anchored }: { locus: Locus; locale: string; anchored: boolean }) {
  const host = hostOf(locus.item.url);
  const [first, ...rest] = locus.clippings;
  return (
    <section class="locus" data-locus id={anchored ? `item-${locus.item.id}` : undefined}>
      {/* A page's title never ends a page of the book: it keeps its first clipping. */}
      <div class="locus-lead">
        <header class="locus-head">
          <a href={`/items/${locus.item.id}`}><h2>{locus.item.title}</h2></a>
          <span class="locus-source">{[host, `saved ${readableDate(locus.item.created_at, locale)}`].filter((part) => part !== null).join(" · ")}</span>
        </header>
        {first === undefined ? null : <ClippingScrap clipping={first} locale={locale} />}
      </div>
      {rest.map((clipping) => <ClippingScrap clipping={clipping} locale={locale} />)}
    </section>
  );
}

// The title page describes what this view of the book holds: the whole book,
// one page's clippings, or those with notes.
function TitlePage({ book, filter, focus, context }: { book: Book; filter: BookFilter; focus: Item | null; context: PageContext }) {
  const volume = book.newer !== null || book.older !== null;
  const noted = filter.notesOnly ? " with notes" : "";
  return (
    <div class="title-page">
      <h1 id="book-title">Commonplace book</h1>
      <div class="flourish" aria-hidden="true">· · ·</div>
      {focus === null ? (
        <p>{counted(book.totals.clippings, "clipping", "clippings")} from {counted(book.totals.pages, "page", "pages")}</p>
      ) : (
        <>
          <p class="title-page-focus">From “{focus.title}”</p>
          <p>{counted(book.clippings, "clipping", "clippings")}{noted} from this page</p>
        </>
      )}
      {focus === null && filter.notesOnly ? <p>Showing the {counted(book.clippings, "clipping", "clippings")} with notes</p> : null}
      {book.totals.since === null ? null : <p>Kept since {monthOf(book.totals.since, context.locale)}</p>}
      {volume ? <p>This volume holds {counted(book.clippings, "clipping", "clippings")}{noted}.</p> : null}
    </div>
  );
}

function EmptyBook({ filtered }: { filtered: boolean }) {
  return (
    <div class="book-empty">
      {filtered ? (
        <p>No clippings match this view. Choose “By page” to see every clipping.</p>
      ) : (
        <>
          <p><b>Your commonplace book is empty.</b></p>
          <p>While you read a saved page, select a passage and choose “Clip it”. The clipping lands here, under the title of the page it came from.</p>
        </>
      )}
    </div>
  );
}

export function BookPage({
  book,
  filter,
  focus,
  seed,
  context,
}: {
  book: Book;
  filter: BookFilter;
  focus: Item | null;
  // The seed the Shuffle link carries, so each visit deals a new order.
  seed: number;
  context: PageContext;
}) {
  const view = viewOf(filter);
  const itemId = filter.itemId;
  const currentSeed = filter.order.kind === "shuffle" ? filter.order.seed : seed;
  const chip = (target: BookView, label: string) => (
    <a
      class="chip"
      href={bookHref({ view: target, itemId, seed: target === "shuffle" ? seed : 0 })}
      aria-current={view === target ? "page" : undefined}
    >
      {label}
    </a>
  );
  return (
    <Layout title="Clippings" context={context} current="clippings" scripts={["book"]}>
      <section class="book" data-book aria-labelledby="book-title">
        <div class="book-cover">
          <span class="book-ribbon" aria-hidden="true" />
          <div class="book-spread" data-spread>
            <div class="book-page book-page-left" aria-hidden="true" />
            <div class="book-page book-page-right" aria-hidden="true" />
            <div class="book-window">
              <div class="book-flow" data-flow>
                <TitlePage book={book} filter={filter} focus={focus} context={context} />
                {book.loci.length === 0
                  ? <EmptyBook filtered={book.totals.clippings > 0} />
                  : book.loci.map((locus) => <LocusSection locus={locus} locale={context.locale} anchored={view !== "shuffle"} />)}
              </div>
            </div>
            <span class="folio folio-left" data-folio="left" aria-hidden="true" />
            <span class="folio folio-right" data-folio="right" aria-hidden="true" />
            <button type="button" class="corner corner-prev" data-turn="-1" aria-label="Previous page" hidden />
            <button type="button" class="corner corner-next" data-turn="1" aria-label="Next page" hidden />
          </div>
        </div>
        <nav class="book-bar" aria-label="Commonplace book">
          <span class="book-chips">
            {chip("by-page", "By page")}
            {chip("notes", "With notes")}
            {chip("shuffle", "Shuffle")}
            {itemId === null ? null : <a class={LINK} href="/clippings">All pages</a>}
          </span>
          <span class="book-turns" data-turns hidden>
            <button type="button" class={ACTION} data-turn="-1">‹ Previous</button>
            <span class="book-count" data-page-count aria-live="polite" />
            <button type="button" class={ACTION} data-turn="1">Next ›</button>
          </span>
          <span class="book-volumes">
            {book.newer === null ? null : (
              <a class={LINK} href={bookHref({ view, itemId, seed: currentSeed, after: book.newer })}>‹ Previous volume</a>
            )}
            {book.older === null ? null : (
              <a class={LINK} href={bookHref({ view, itemId, seed: currentSeed, before: book.older })}>Next volume ›</a>
            )}
          </span>
        </nav>
      </section>
    </Layout>
  );
}

export function ClippingPage({ clipping, context }: { clipping: Clipping; context: PageContext }) {
  const { annotation, item } = clipping;
  const path = `/clippings/${annotation.id}`;
  return (
    <Layout title="Clipping" context={context} current="clippings">
      <Sheet labelledBy="clipping-title" narrow>
        <p class="sheet-kicker">Clipping from</p>
        <h1 id="clipping-title" class="sheet-title"><a class={LINK} href={`/items/${item.id}`}>{item.title}</a></h1>
        <blockquote class="clipping-quote sheet-quote"><span class="wash">{annotation.quote}</span></blockquote>
        <form class="note-form" action={path} method="post">
          <label for="note">Your note</label>
          <textarea id="note" name="note" class={FIELD} rows="5" maxlength={NOTE_MAX_LENGTH} autocomplete="off" placeholder="Why this passage matters, in a line or two…">{annotation.note ?? ""}</textarea>
          <p class="sheet-actions">
            <button type="submit" class={SUBMIT}>Save note</button>
            <a class={ACTION} href={bookHrefForItem(item)}>Back to the book</a>
          </p>
        </form>
        <p class="sheet-note">
          Clipped <time datetime={annotation.created_at}>{readableDate(annotation.created_at, context.locale)}</time>
          {" · "}
          <a class={LINK} href={`${path}/delete`}>Remove clipping…</a>
        </p>
      </Sheet>
    </Layout>
  );
}

function bookHrefForItem(item: Item): string {
  return `/clippings?item=${item.id}`;
}

export function RemoveClippingPage({ clipping, context }: { clipping: Clipping; context: PageContext }) {
  const { annotation, item } = clipping;
  const path = `/clippings/${annotation.id}`;
  return (
    <Layout title="Remove clipping" context={context} current="clippings">
      <Sheet labelledBy="remove-title" narrow>
        <h1 id="remove-title" class="sheet-title">Remove this clipping from “{item.title}”?</h1>
        <blockquote class="clipping-quote sheet-quote"><span class="wash">{annotation.quote}</span></blockquote>
        <p class="sheet-lede">
          The clipping and its note leave your commonplace book, and the passage is no longer marked on the page. The saved page itself stays. You can't undo this.
        </p>
        <div class="sheet-actions">
          <form action={`${path}/delete`} method="post">
            <button type="submit" class={SUBMIT}>Remove clipping</button>
          </form>
          <a class={ACTION} href={path}>Cancel</a>
        </div>
      </Sheet>
    </Layout>
  );
}
