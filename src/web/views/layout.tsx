import { raw } from "./jsx-runtime";

// Runs before the first paint so a saved theme never flashes the other one.
const THEME_BOOTSTRAP = `try{var t=localStorage.getItem("cp-theme");if(t)document.documentElement.setAttribute("data-theme",t)}catch(e){}`;

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
        <title>{`${title} — Commonplace`}</title>
        <link rel="stylesheet" href="/app.css" />
        <script>{raw(THEME_BOOTSTRAP)}</script>
        <script src="/reader.js" type="module" defer></script>
      </head>
      <body class="bg-base-200 text-base-content min-h-screen">
        <header class="cp-rule bg-base-100 sticky top-0 z-10">
          <div class="mx-auto flex max-w-4xl items-center gap-6 px-6 py-3">
            <a href="/library" class="text-sm font-semibold tracking-tight">
              Commonplace
            </a>
            <form action="/search" method="get" class="flex flex-1 items-center gap-2">
              <span class="text-secondary">
                <SearchIcon />
              </span>
              <input
                type="search"
                name="q"
                value={query ?? ""}
                placeholder="Search every block"
                class="w-full bg-transparent py-1 text-sm outline-none placeholder:text-secondary"
              />
            </form>
            <button
              type="button"
              data-cp-theme-toggle
              aria-label="Switch theme"
              class="text-secondary hover:text-primary"
            >
              <ContrastIcon />
            </button>
          </div>
        </header>
        <main class="mx-auto max-w-4xl px-6 py-10">{children}</main>
      </body>
    </html>
  );
}

export function page(node: unknown, status = 200): Response {
  return new Response(`<!DOCTYPE html>${String(node)}`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
