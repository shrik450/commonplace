import type { SearchResult } from "../../services/library";
import { Layout } from "./layout";

function Snippet({ result }: { result: SearchResult }) {
  return (
    <p class="font-reading mt-1 text-sm">
      {result.snippet.map((part) =>
        part.hit ? <span class="cp-hit">{part.text}</span> : part.text,
      )}
    </p>
  );
}

function Hit({ result }: { result: SearchResult }) {
  const link = `/items/${result.item.id}#b${result.block_index}`;
  return (
    <li class="cp-rule py-4">
      <a href={link} class="block hover:text-primary">
        <span class="text-secondary text-xs tracking-widest uppercase">
          {result.item.title}
        </span>
        <Snippet result={result} />
      </a>
      {result.is_content ? null : (
        <p class="text-secondary mt-1 text-xs">Outside the reader view</p>
      )}
    </li>
  );
}

export function SearchPage({
  query,
  results,
}: {
  query: string;
  results: SearchResult[];
}) {
  return (
    <Layout title="Search" query={query}>
      <h1 class="text-secondary mb-2 text-xs tracking-widest uppercase">
        Search
      </h1>
      {query === "" ? (
        <p class="text-secondary py-8 text-sm">
          Type a word in the bar above. Search reads every block, including the
          ones the reader view hides.
        </p>
      ) : results.length === 0 ? (
        <p class="text-secondary py-8 text-sm">
          Nothing matches “{query}”.
        </p>
      ) : (
        <ul>{results.map((result) => (
          <Hit result={result} />
        ))}</ul>
      )}
    </Layout>
  );
}
