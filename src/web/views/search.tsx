import type { SearchResult } from "../../services/library";
import { LINK, Layout, PageHeading } from "./layout";
import type { UserSettings } from "../../contracts/settings";

function Snippet({ result }: { result: SearchResult }) {
  return (
    <span class="font-reading mt-1.5 block text-base leading-relaxed break-words">
      {result.snippet.map((part) =>
        part.hit ? <span class="cp-hit">{part.text}</span> : part.text,
      )}
    </span>
  );
}

function Hit({ result }: { result: SearchResult }) {
  const link = `/items/${result.item.id}#b${result.block_index}`;
  return (
    <li class="cp-rule py-5">
      <a href={link} class={`block ${LINK}`}>
        <span class="text-secondary block text-xs break-words">
          {result.item.title}
        </span>
        <Snippet result={result} />
      </a>
      {result.is_content ? null : (
        <p class="text-secondary mt-1 text-xs">
          This match appears outside the article content.
        </p>
      )}
    </li>
  );
}

export function SearchPage({
  query,
  results,
  settings,
}: {
  query: string;
  results: SearchResult[];
  settings?: UserSettings;
}) {
  return (
    <Layout title="Search" query={query} settings={settings}>
      <PageHeading>
        {query === "" ? "Search" : `Results for “${query}”`}
      </PageHeading>
      {query === "" ? (
        <p class="text-secondary max-w-prose py-8 text-sm">
          Enter a word in the search field. Commonplace searches every saved
          page, including text outside the article content.
        </p>
      ) : results.length === 0 ? (
        <p class="text-secondary max-w-prose py-8 text-sm">
          Nothing matches “{query}”. Check the spelling, or try a shorter term.
        </p>
      ) : (
        <ul>{results.map((result) => (
          <Hit result={result} />
        ))}</ul>
      )}
    </Layout>
  );
}
