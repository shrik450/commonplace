import { raw } from "./jsx-runtime";

// Runs before the first paint so a saved theme never flashes the other one.
const THEME_BOOTSTRAP = `try{var t=localStorage.getItem("cp-theme");if(t)document.documentElement.setAttribute("data-theme",t)}catch(e){}`;

// Interactive state lives in the class attribute, not in a CSS component
// class, so `test/invariants/ui-guidelines.test.ts` can read it off the
// rendered page. See `.claude/skills/web-design-guidelines/`.
const FOCUS =
  "rounded-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

// A quiet navigation link: muted until you point at it.
export const LINK = `text-secondary hover:text-primary transition-colors duration-150 ${FOCUS}`;

// A normal action: accent text with an underline that thickens on hover.
export const ACTION = `text-primary underline decoration-1 underline-offset-4 hover:decoration-2 hover:text-primary/80 transition-colors duration-150 ${FOCUS}`;

// The one primary action on a page. Filled, per docs/design.md.
export const SUBMIT = `bg-primary text-primary-content hover:bg-primary/85 active:bg-primary/70 px-3 py-1 text-sm transition-colors duration-150 ${FOCUS}`;

// A text field on a hairline rule. The rule darkens to the accent on focus.
export const FIELD = `bg-transparent py-1 text-sm outline-none placeholder:text-secondary ${FOCUS}`;

// One heading for every page of chrome. The reader and the home page set
// their own size, because on those pages the heading is the loudest thing.
export function PageHeading({ children }: { children?: unknown }) {
  return (
    <h1 class="font-reading mb-6 text-2xl leading-tight text-pretty">
      {children}
    </h1>
  );
}

export type LayoutProps = {
  title: string;
  query?: string;
  children?: unknown;
};

function SearchIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function ContrastIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function Layout({ title, query, children }: LayoutProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta
          name="theme-color"
          content="#f7f3ec"
          media="(prefers-color-scheme: light)"
        />
        <meta
          name="theme-color"
          content="#14151a"
          media="(prefers-color-scheme: dark)"
        />
        <title>{`${title} — Commonplace`}</title>
        <link rel="stylesheet" href="/app.css" />
        <script>{raw(THEME_BOOTSTRAP)}</script>
        <script src="/reader.js" type="module" defer></script>
      </head>
      <body class="bg-base-200 text-base-content min-h-screen">
        <a
          href="#main"
          class={`bg-base-100 sr-only px-3 py-2 text-sm focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-20 ${LINK}`}
        >
          Skip to the page
        </a>
        <header class="cp-rule bg-base-100 sticky top-0 z-10">
          <div class="mx-auto flex max-w-4xl flex-wrap items-center gap-x-5 gap-y-2 px-6 py-3">
            <a
              href="/library"
              translate="no"
              class={`text-base-content hover:text-primary text-sm font-semibold tracking-tight transition-colors duration-150 ${FOCUS}`}
            >
              Commonplace
            </a>
            <form
              action="/search"
              method="get"
              role="search"
              class="focus-within:text-primary order-last flex w-full min-w-0 items-center gap-2 sm:order-none sm:w-auto sm:flex-1"
            >
              <span class="text-secondary" aria-hidden="true">
                <SearchIcon />
              </span>
              <input
                type="search"
                name="q"
                value={query ?? ""}
                aria-label="Search your library"
                autocomplete="off"
                placeholder="Search everything you saved…"
                class={`w-full min-w-0 ${FIELD}`}
              />
            </form>
            <a href="/settings" class={`ml-auto text-sm sm:ml-0 ${LINK}`}>
              Settings
            </a>
            <a href="/logout" class={`text-sm ${LINK}`}>
              Log out
            </a>
            <button
              type="button"
              data-cp-theme-toggle
              aria-label="Switch between the light and dark theme"
              class={`p-1 ${LINK}`}
            >
              <ContrastIcon />
            </button>
          </div>
        </header>
        <main id="main" class="mx-auto max-w-4xl px-6 py-10">
          {children}
        </main>
      </body>
    </html>
  );
}

// Every failure a reader can reach says what went wrong and what to do next,
// on a real page. A bare status line leaves them with nowhere to go.
export function ErrorPage({
  title,
  message,
  code,
  href = "/library",
  linkLabel = "Go to your library",
}: {
  title: string;
  message: string;
  code?: string;
  href?: string;
  linkLabel?: string;
}) {
  return (
    <Layout title={title}>
      <h1 class="font-reading text-3xl leading-tight text-pretty">{title}</h1>
      <p class="mt-4 max-w-prose text-sm leading-relaxed">{message}</p>
      <p class="mt-8">
        <a class={`text-sm ${ACTION}`} href={href}>
          {linkLabel}
        </a>
      </p>
      {code === undefined ? null : (
        <p class="text-secondary mt-10 font-mono text-xs" translate="no">
          {code}
        </p>
      )}
    </Layout>
  );
}

export function page(node: unknown, status = 200): Response {
  return new Response(`<!DOCTYPE html>${String(node)}`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
