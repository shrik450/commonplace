import { ACTION } from "./controls";
import { Layout } from "./layout";
import { Sheet } from "./sheet";

export function HomePage() {
  return (
    <Layout title="Commonplace" context={null}>
      <Sheet labelledBy="home-title" folded>
        <h1 id="home-title" class="sheet-title sheet-title-large">Save what you read.</h1>
        <p class="sheet-lede">
          Commonplace saves the full article instead of only its link. Read the
          article in a focused view, search its text, and clip the passages worth
          keeping into a commonplace book. The saved copy remains available if the
          original page moves or disappears.
        </p>
        <p class="sheet-actions">
          <a class={ACTION} href="/library">Go to your library</a>
        </p>
      </Sheet>
    </Layout>
  );
}
