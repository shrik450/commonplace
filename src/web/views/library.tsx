import { parseIso } from "../../contracts/clock";
import type { Item } from "../../contracts/item";
import { FIELD, Layout, PageHeading, SUBMIT } from "./layout";

export function hostOf(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function readableDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(parseIso(iso));
}

function Row({ item, locale }: { item: Item; locale: string }) {
  const host = hostOf(item.url);
  return (
    <li class="cp-rule py-5">
      <a
        href={`/items/${item.id}`}
        class="hover:text-primary focus-visible:outline-primary block rounded-xs transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <span class="font-reading block text-lg text-pretty break-words">
          {item.title}
        </span>
        <span class="text-secondary mt-1.5 block text-xs break-words">
          {[host, item.author].filter((part) => part !== null && part !== "").join(" · ")}
          {host === null && item.author === null ? "" : " · "}
          <time datetime={item.created_at}>
            {readableDate(item.created_at, locale)}
          </time>
        </span>
      </a>
    </li>
  );
}

export function LibraryPage({
  items,
  locale,
}: {
  items: Item[];
  locale: string;
}) {
  return (
    <Layout title="Library">
      <PageHeading>Your library</PageHeading>
      <form
        action="/items"
        method="post"
        class="cp-rule flex items-center gap-3 py-3"
      >
        <input
          type="url"
          name="url"
          required
          aria-label="Address of the page to save"
          autocomplete="url"
          spellcheck="false"
          placeholder="Paste a link, like https://example.com/an-essay…"
          class={`min-w-0 flex-1 ${FIELD}`}
        />
        <button type="submit" class={SUBMIT}>
          Save page
        </button>
      </form>
      {items.length === 0 ? (
        <p class="text-secondary max-w-prose py-8 text-sm">
          Your library is empty. Enter a web address to save a searchable copy
          of the page.
        </p>
      ) : (
        <ul>{items.map((item) => (
          <Row item={item} locale={locale} />
        ))}</ul>
      )}
    </Layout>
  );
}
