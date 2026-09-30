import { cursorOf, formatCursor } from "../../contracts/cursor";
import type { FetchRequest } from "../../contracts/item";
import type { Card, LibraryPage } from "../../services/library";
import { FIELD, SUBMIT } from "./controls";
import { cardDate, counted, hostOf, readingMinutes } from "./format";
import { ScissorsIcon } from "./icons";
import { Layout, type PageContext } from "./layout";
import { attemptDetail, saveStateLabel } from "./save";

// The most slivers a pile draws. The script shows as many as a pile's count
// calls for; `box.css` sizes each by its depth.
const PILE_SLIVERS = 11;

function Pile({ side }: { side: "back" | "front" }) {
  const depths = Array.from({ length: PILE_SLIVERS }, (_, depth) => depth);
  // The largest sliver sits next to the visible cards: last in the back pile,
  // first in the front one.
  const ordered = side === "back" ? depths.toReversed() : depths;
  return (
    <div class={`pile pile-${side}`} data-pile={side} aria-hidden="true">
      {ordered.map((depth) => <i style={`--depth: ${depth}`} />)}
    </div>
  );
}

function ItemCard({ card, context, id }: { card: Card; context: PageContext; id?: string }) {
  const { item, clippings } = card;
  const host = hostOf(item.url);
  const meta = [
    host,
    item.author,
    `${readingMinutes(item.content_length)} min read`,
    clippings > 0 ? counted(clippings, "clipping", "clippings") : null,
  ].filter((part) => part !== null && part !== "");
  return (
    <li class="card" data-card="item" data-cursor={formatCursor(cursorOf(item))} id={id}>
      <a
        class="card-link"
        href={`/items/${item.id}`}
        aria-labelledby={`title-${item.id}`}
        aria-describedby={`details-${item.id}`}
      >
        <span class="card-title" id={`title-${item.id}`}>{item.title}</span>
        <span class="card-corner">
          {clippings > 0 ? (
            <span class="card-clips" aria-hidden="true"><ScissorsIcon />{String(clippings)}</span>
          ) : null}
          <time datetime={item.created_at}>{cardDate(item.created_at, context.locale, context.today)}</time>
        </span>
        {host === null ? null : <span class="card-host" aria-hidden="true">{host}</span>}
        <span class="card-details" id={`details-${item.id}`}>
          {item.excerpt === "" ? null : <span class="card-excerpt" data-card-excerpt>{item.excerpt}</span>}
          <span class="card-meta">{meta.join(" · ")}</span>
        </span>
      </a>
    </li>
  );
}

function SaveCard({ request }: { request: FetchRequest }) {
  const failed = request.state === "failed";
  const detail = attemptDetail(request);
  return (
    <li class="card card-save" data-card="save" data-state={failed ? "failed" : "saving"}>
      <a class="card-link" href={`/saves/${request.id}`}>
        <span class="card-title" translate="no">{request.url}</span>
        <span class="card-corner">
          <span class="stamp" aria-hidden="true">{failed ? "Failed" : "Saving"}</span>
        </span>
        <span class="card-details">
          <span class="card-meta">
            {[saveStateLabel(request), detail, request.error_code === null ? null : `Error code: ${request.error_code}`]
              .filter((part) => part !== null)
              .join(" · ")}
          </span>
        </span>
      </a>
    </li>
  );
}

// A guide card stands between pages of the box, like the tabbed dividers in a
// card catalogue. With the script the box loads the next page as you near a
// guide, so a guide only shows when that fails or there is no script.
function GuideCard({ side, href, children, id }: { side: "newer" | "older"; href: string; children: string; id?: string }) {
  return (
    <li class="card card-guide" data-card="guide" data-guide={side} id={id}>
      <a class="card-link" href={href}>
        <span class="card-title">{children}</span>
      </a>
    </li>
  );
}

function EmptyCard() {
  return (
    <li class="card card-empty" data-card="empty">
      <p class="card-title">Your library is empty.</p>
      <form class="card-save-form" action="/items" method="post">
        <label class="sr-only" for="first-url">Address of the page to save</label>
        <input
          id="first-url"
          class={FIELD}
          type="url"
          name="url"
          required
          autocomplete="url"
          spellcheck="false"
          placeholder="https://example.com/an-essay…"
        />
        <button type="submit" class={SUBMIT}>Save page</button>
      </form>
      <p class="card-meta">Save a page, and Commonplace files a full copy here as its first card.</p>
    </li>
  );
}

export function LibraryView({ library, context }: { library: LibraryPage; context: PageContext }) {
  const empty = library.total === 0 && library.saves.length === 0;
  return (
    <Layout title="Library" context={context} current="library" scripts={["index-box"]}>
      <section
        class="index-box"
        data-index-box
        aria-labelledby="library-title"
        data-newer-count={library.newerCount}
        data-older-count={library.olderCount}
      >
        <h1 id="library-title" class="sr-only">Your library</h1>
        <div class="box-well">
          <ol class="stack" data-stack tabindex="0" aria-label="Saved pages, newest first">
            {library.newer === null ? null : (
              <GuideCard side="newer" href={`/library?after=${encodeURIComponent(formatCursor(library.newer))}#end`}>Newer cards</GuideCard>
            )}
            {empty ? <EmptyCard /> : null}
            {library.saves.map((request) => <SaveCard request={request} />)}
            {library.cards.map((card, index) => (
              <ItemCard
                card={card}
                context={context}
                id={library.older === null && index === library.cards.length - 1 ? "end" : undefined}
              />
            ))}
            {library.older === null ? null : (
              <GuideCard side="older" id="end" href={`/library?before=${encodeURIComponent(formatCursor(library.older))}`}>Older cards</GuideCard>
            )}
          </ol>
          <p class="sr-only" role="status" data-box-status />
          <Pile side="back" />
          <Pile side="front" />
          <div class="box-shade" aria-hidden="true" />
        </div>
        <div class="box-front" aria-hidden="true" />
        <span class="box-corner box-corner-tl" aria-hidden="true" />
        <span class="box-corner box-corner-tr" aria-hidden="true" />
        <span class="box-corner box-corner-bl" aria-hidden="true" />
        <span class="box-corner box-corner-br" aria-hidden="true" />
      </section>
    </Layout>
  );
}
