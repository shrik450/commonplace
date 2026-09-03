// Keep interactive state in these class strings so the UI invariant can check
// the rendered markup.
const FOCUS =
  "rounded-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

// Styles secondary navigation links.
export const LINK = `text-secondary hover:text-primary transition-colors duration-150 ${FOCUS}`;

// Styles non-primary actions.
export const ACTION = `text-primary underline decoration-1 underline-offset-4 hover:decoration-2 hover:text-primary/80 transition-colors duration-150 ${FOCUS}`;

// Styles the primary action on a page.
export const SUBMIT = `bg-primary text-primary-content hover:bg-primary/85 active:bg-primary/70 px-3 py-1 text-sm transition-colors duration-150 ${FOCUS}`;

// Styles text fields and their focus state.
export const FIELD = `bg-transparent py-1 text-sm outline-none placeholder:text-secondary ${FOCUS}`;

// Renders the standard page heading. The home and reader views use larger
// headings.
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
      </head>
      <body class="bg-base-200 text-base-content min-h-screen">
        <a
          href="#main"
          class={`bg-base-100 sr-only px-3 py-2 text-sm focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-20 ${LINK}`}
        >
          Skip to main content
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
          </div>
        </header>
        <main id="main" class="mx-auto max-w-4xl px-6 py-10">
          {children}
        </main>
      </body>
    </html>
  );
}

// Renders a browser error with a recovery link and optional diagnostic code.
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
