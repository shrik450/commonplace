import { FIELD, LINK, SUBMIT } from "./controls";
import { counted } from "./format";
import { SearchIcon, SettingsIcon } from "./icons";
import type { Child } from "./jsx-runtime";
import type { PageContext } from "./layout";

// The views that hang from the top edge as tabs.
export type View = "library" | "clippings";

function Tab({ href, current, children }: { href: string; current: boolean; children?: Child }) {
  return (
    <a href={href} class="tab" aria-current={current ? "page" : undefined}>
      {children}
    </a>
  );
}

// Saving drops a blank card from the top bar. `<details>` opens and closes it
// without a script; `save-card.js` adds Escape, click-outside, and focus.
export function SaveDrop() {
  return (
    <details class="save-drop" data-save-drop>
      <summary class={SUBMIT}>Save a page</summary>
      <form class="save-card" action="/items" method="post">
        <label class="save-card-label" for="save-drop-url">A new card</label>
        <div class="save-card-row">
          <input
            id="save-drop-url"
            class={FIELD}
            type="url"
            name="url"
            required
            autocomplete="url"
            spellcheck="false"
            placeholder="https://example.com/an-essay…"
          />
          <button type="submit" class={SUBMIT}>Save page</button>
        </div>
        <p class="save-card-hint">Commonplace keeps a full copy and files it in your library.</p>
      </form>
    </details>
  );
}

export function Masthead({ context, current, query }: { context: PageContext | null; current?: View; query?: string }) {
  return (
    <header class="masthead">
      <div class="masthead-inner">
        <a href={context === null ? "/" : "/library"} class="brand" translate="no">
          <img src="/icon.svg" alt="" width="32" height="32" />
          <span class="brand-name">Commonplace</span>
        </a>
        {context === null ? (
          <a href="/login" class={`masthead-link ${LINK}`}>Sign in</a>
        ) : (
          <>
            <nav class="tabs" aria-label="Main">
              <Tab href="/library" current={current === "library"}>
                Library
                <span class="tab-count">
                  <span aria-hidden="true">{String(context.cardCount)}</span>
                  <span class="sr-only">, {counted(context.cardCount, "card", "cards")}</span>
                </span>
              </Tab>
              <Tab href="/clippings" current={current === "clippings"}>Clippings</Tab>
            </nav>
            <form action="/search" method="get" role="search" class="search-slip">
              <SearchIcon />
              <input
                type="search"
                name="q"
                value={query ?? ""}
                aria-label="Search your library"
                autocomplete="off"
                placeholder="Search everything you saved…"
              />
            </form>
            <a href="/search" class="masthead-icon search-link" aria-label="Search your library">
              <SearchIcon size={20} />
            </a>
            <SaveDrop />
            <a href="/save" class={`save-link ${SUBMIT}`}>Save</a>
            <a href="/settings" class={`masthead-link settings-link ${LINK}`}>
              <SettingsIcon size={18} />
              <span class="settings-label">Settings</span>
            </a>
            <a href="/logout" class={`masthead-link signout-link ${LINK}`}>Sign out</a>
          </>
        )}
      </div>
    </header>
  );
}
