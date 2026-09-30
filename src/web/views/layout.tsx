import type { UserSettings } from "../../contracts/settings";
import type { ClientScript } from "../client/scripts";
import type { Child } from "./jsx-runtime";
import { Masthead, type View } from "./masthead";
import { Sheet } from "./sheet";
import { ACTION, LINK } from "./controls";

// What every signed-in page needs to draw the desk around its content.
export type PageContext = {
  settings: UserSettings;
  locale: string;
  cardCount: number;
  today: Date;
};

export type LayoutProps = {
  title: string;
  // Public pages have no context: no tabs, no search, no counts.
  context: PageContext | null;
  current?: View;
  query?: string;
  scripts?: readonly ClientScript[];
  refreshSeconds?: number;
  children?: Child;
};

const DESK_COLORS = { parchment: "#efe7d8", ink: "#14151a" } as const;

function themeOf(settings: UserSettings | undefined): keyof typeof DESK_COLORS | undefined {
  if (settings?.theme === "light") return "parchment";
  if (settings?.theme === "dark") return "ink";
  return undefined;
}

export function Layout({ title, context, current, query, scripts = [], refreshSeconds, children }: LayoutProps) {
  const settings = context?.settings;
  const theme = themeOf(settings);
  const loaded: ClientScript[] = context === null ? [...scripts] : ["save-card", ...scripts];
  return (
    <html lang="en" data-theme={theme}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        {theme === undefined ? (
          <>
            <meta name="theme-color" content={DESK_COLORS.parchment} media="(prefers-color-scheme: light)" />
            <meta name="theme-color" content={DESK_COLORS.ink} media="(prefers-color-scheme: dark)" />
          </>
        ) : (
          <meta name="theme-color" content={DESK_COLORS[theme]} />
        )}
        <title>{`${title} — Commonplace`}</title>
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" sizes="any" />
        {refreshSeconds === undefined ? null : (
          <meta http-equiv="refresh" content={String(refreshSeconds)} />
        )}
        <link rel="preload" href="/fonts/newsreader-latin-opsz-normal.woff2" as="font" type="font/woff2" crossorigin="anonymous" />
        <link rel="stylesheet" href="/app.css" />
        {[...new Set(loaded)].map((name) => <script type="module" src={`/scripts/${name}.js`} />)}
      </head>
      <body
        data-cp-font={settings?.font}
        style={settings === undefined ? undefined : `--cp-measure: ${settings.text_width}; --cp-size: ${settings.text_size}`}
      >
        <a href="#main" class={`skip-link ${LINK}`}>Skip to main content</a>
        <Masthead context={context} current={current} query={query} />
        <main id="main" class="desk">{children}</main>
      </body>
    </html>
  );
}

// Renders a page error with a recovery link and an optional diagnostic code.
export function ErrorPage({
  title,
  message,
  code,
  href = "/library",
  linkLabel = "Go to your library",
  context,
}: {
  context: PageContext | null;
  title: string;
  message: string;
  code?: string;
  href?: string;
  linkLabel?: string;
}) {
  return (
    <Layout title={title} context={context}>
      <Sheet labelledBy="error-title">
        <h1 id="error-title" class="sheet-title">{title}</h1>
        <p id="error-message" class="sheet-lede">{message}</p>
        <p class="sheet-actions">
          <a class={ACTION} href={href}>{linkLabel}</a>
        </p>
        {code === undefined ? null : (
          <p class="sheet-code" translate="no">{code}</p>
        )}
      </Sheet>
    </Layout>
  );
}

export function page(node: Child, status = 200): Response {
  return new Response(`<!DOCTYPE html>${String(node)}`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
