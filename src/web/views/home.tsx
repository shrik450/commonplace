import { ACTION, Layout } from "./layout";

export function HomePage() {
  return (
    <Layout title="Commonplace">
      <h1 class="font-reading text-4xl leading-tight text-pretty">
        Keep what you read.
      </h1>
      <p class="mt-5 max-w-prose text-base leading-relaxed">
        Save a page and Commonplace keeps the whole article, not just the link.
        Read it in a clean column, search every word of it, and highlight the
        parts you want back later. It stays yours after the original moves or
        disappears.
      </p>
      <p class="mt-10">
        <a class={`text-sm ${ACTION}`} href="/library">
          Go to your library
        </a>
      </p>
    </Layout>
  );
}
