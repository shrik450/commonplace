import { parseIso } from "../../contracts/clock";
import type { FetchRequest, Item } from "../../contracts/item";
import { SaveRequestRow } from "./save";
import { FIELD, Layout, PageHeading, SUBMIT } from "./layout";
import type { UserSettings } from "../../contracts/settings";

export function hostOf(url: string): string | null {
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
  saveRequests,
  locale,
  settings,
}: {
  items: Item[];
  saveRequests: FetchRequest[];
  locale: string;
  settings?: UserSettings;
}) {
  return (
    <Layout title="Library" settings={settings}>
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
      {saveRequests.length === 0 ? null : (
        <section class="mt-10">
          <h2 class="cp-rule mb-0 pb-2 text-base font-semibold">
            Save activity
          </h2>
          <ul>{saveRequests.map((request) => (
            <SaveRequestRow request={request} />
          ))}</ul>
        </section>
      )}
      {items.length === 0 ? (
        <p class="text-secondary max-w-prose py-8 text-sm">
          Your library is empty. Enter a web address to save a searchable copy
          of the page.
        </p>
      ) : saveRequests.length === 0 ? (
        <ul class="mt-10">{items.map((item) => (
          <Row item={item} locale={locale} />
        ))}</ul>
      ) : (
        <section class="mt-10">
          <h2 class="cp-rule mb-0 pb-2 text-base font-semibold">
            Saved pages
          </h2>
          <ul>{items.map((item) => (
            <Row item={item} locale={locale} />
          ))}</ul>
        </section>
      )}
    </Layout>
  );
}
