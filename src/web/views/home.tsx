import { Layout } from "./layout";

export function HomePage() {
  return (
    <Layout title="Commonplace">
      <h1 class="font-reading text-4xl leading-tight">Commonplace</h1>
      <p class="text-secondary mt-4 max-w-prose text-sm">
        One transcript per item, many views. Every page you save becomes an
        ordered stream of characters, and search, highlights, and the reader
        view are all projections through it.
      </p>
      <p class="mt-8">
        <a class="text-primary text-sm underline underline-offset-4" href="/library">
          Open the library
        </a>
      </p>
    </Layout>
  );
}
