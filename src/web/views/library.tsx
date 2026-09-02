import { parseIso } from "../../contracts/clock";
import type { Item } from "../../contracts/item";
import { Layout } from "./layout";

export function hostOf(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function readableDate(iso: string): string {
  return parseIso(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function Row({ item }: { item: Item }) {
  const host = hostOf(item.url);
  return (
    <li class="cp-rule py-4">
      <a href={`/items/${item.id}`} class="block hover:text-primary">
        <span class="font-reading text-lg">{item.title}</span>
      </a>
      <p class="text-secondary mt-1 text-xs">
        {[host, item.author, readableDate(item.created_at)]
          .filter((part) => part !== null && part !== "")
          .join(" · ")}
      </p>
    </li>
  );
}

export function LibraryPage({ items }: { items: Item[] }) {
  return (
    <Layout title="Library">
      <h1 class="text-secondary mb-2 text-xs tracking-widest uppercase">
        Library
      </h1>
      {items.length === 0 ? (
        <p class="text-secondary py-8 text-sm">
          Nothing saved yet. Queue a page with <code>bun run cp ingest</code>.
        </p>
      ) : (
        <ul class="cp-rule border-t-0">{items.map((item) => (
          <Row item={item} />
        ))}</ul>
      )}
    </Layout>
  );
}
