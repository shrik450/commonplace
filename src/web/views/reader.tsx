import type { Annotation, Item } from "../../contracts/item";
import { raw } from "./jsx-runtime";
import { hostOf, readableDate } from "./library";
import { Layout } from "./layout";

export type ReaderProps = {
  item: Item;
  html: string;
  annotations: Annotation[];
};

export function ReaderPageView({ item, html, annotations }: ReaderProps) {
  const host = hostOf(item.url);
  return (
    <Layout title={item.title}>
      <article class="mx-auto max-w-[72ch] pl-6">
        <header class="cp-rule pb-6">
          <h1 class="font-reading text-3xl leading-tight">{item.title}</h1>
          <p class="text-secondary mt-2 text-xs">
            {[item.author, host, readableDate(item.created_at)]
              .filter((part) => part !== null && part !== "")
              .join(" · ")}
          </p>
          <nav class="text-secondary mt-4 flex gap-4 text-xs">
            <a class="hover:text-primary" href={`/items/${item.id}/raw`}>
              Transcript
            </a>
            <a class="hover:text-primary" href={`/items/${item.id}/capture`}>
              Capture
            </a>
            {item.url === null ? null : (
              <a class="hover:text-primary" href={item.url} rel="noreferrer">
                Original
              </a>
            )}
            <span>
              {annotations.length === 1
                ? "1 note"
                : `${annotations.length} notes`}
            </span>
          </nav>
        </header>
        <div class="mt-8">{raw(html)}</div>
      </article>
    </Layout>
  );
}
