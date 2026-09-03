import type { Annotation, Item } from "../../contracts/item";
import type { UserSettings } from "../../contracts/settings";
import { raw } from "./jsx-runtime";
import { hostOf, readableDate } from "./library";
import { LINK, Layout } from "./layout";

export type ReaderProps = {
  item: Item;
  html: string;
  annotations: Annotation[];
  locale: string;
  settings: UserSettings;
};

function noteCount(total: number): string {
  if (total === 0) return "No highlights yet";
  if (total === 1) return "1 highlight";
  return `${total} highlights`;
}

export function ReaderPageView({
  item,
  html,
  annotations,
  locale,
  settings,
}: ReaderProps) {
  const host = hostOf(item.url);
  return (
    <Layout title={item.title} settings={settings}>
      <article
        class="mx-auto pl-6"
        data-cp-reader
        data-cp-font={settings.font}
        data-cp-text-size={settings.text_size}
        data-cp-line-spacing={settings.line_spacing}
        data-cp-paragraph-spacing={settings.paragraph_spacing}
        data-cp-text-width={settings.text_width}
        style={`--cp-text-size: ${settings.text_size}px; --cp-line-spacing: ${settings.line_spacing / 100}; --cp-paragraph-spacing: ${settings.paragraph_spacing / 100}em; --cp-text-width: ${settings.text_width}ch`}
      >
        <header class="cp-rule pb-6">
          <h1 class="font-reading text-3xl leading-tight text-pretty">{item.title}</h1>
          <p class="text-secondary mt-3 text-xs break-words">
            {[item.author, host].filter((part) => part !== null && part !== "").join(" · ")}
            {item.author === null && host === null ? "" : " · "}
            <time datetime={item.created_at}>{readableDate(item.created_at, locale)}</time>
          </p>
          <nav aria-label="Other views of this page" class="text-secondary mt-4 flex flex-wrap gap-4 text-xs">
            <a class={LINK} href={`/items/${item.id}/raw`}>Structured text</a>
            <a class={LINK} href={`/items/${item.id}/capture`}>Saved copy</a>
            <a class={LINK} href={item.url} rel="noreferrer">Original page</a>
            <span>{noteCount(annotations.length)}</span>
          </nav>
        </header>
        {/* The projection comes from the archived page rather than this interface. */}
        <div class="mt-8" data-cp-projected>{raw(html)}</div>
      </article>
    </Layout>
  );
}
