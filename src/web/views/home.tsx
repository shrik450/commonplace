import { ACTION, Layout } from "./layout";

export function HomePage() {
  return (
    <Layout title="Commonplace">
      <h1 class="font-reading text-4xl leading-tight text-pretty">
        Save what you read.
      </h1>
      <p class="mt-5 max-w-prose text-base leading-relaxed">
        Commonplace saves the full article instead of only its link. Read the
        article in a focused view, search its text, and highlight passages. The
        saved copy remains available if the original page moves or disappears.
      </p>
      <p class="mt-10">
        <a class={`text-sm ${ACTION}`} href="/library">
          Go to your library
        </a>
      </p>
    </Layout>
  );
}
