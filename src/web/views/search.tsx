import type { SearchResult } from "../../services/library";
import { hostOf } from "./format";
import { SearchIcon } from "./icons";
import { Layout, type PageContext } from "./layout";

function Snippet({ result }: { result: SearchResult }) {
  return (
    <span class="result-snippet">
      {result.snippet.map((part) => (part.hit ? <mark class="hit">{part.text}</mark> : part.text))}
    </span>
  );
}

function ResultCard({ result }: { result: SearchResult }) {
  return (
    <li>
      <a class="result-card" href={`/items/${result.item.id}#b${result.block_index}`}>
        <span class="result-source">
          <span class="result-title">{result.item.title}</span>
          <span class="result-host">{hostOf(result.item.url)}</span>
        </span>
        <Snippet result={result} />
        {result.is_content ? null : (
          <span class="result-aside">This match appears outside the article content.</span>
        )}
      </a>
    </li>
  );
}

// On a phone the header's search slip folds away, so the search page carries
// its own.
function PageSearch({ query }: { query: string }) {
  return (
    <form action="/search" method="get" role="search" class="search-slip search-slip-page">
      <SearchIcon />
      <input
        type="search"
        name="q"
        value={query}
        aria-label="Search your library"
        autocomplete="off"
        placeholder="Search everything you saved…"
      />
    </form>
  );
}

export function SearchPage({
  query,
  results,
  more,
  context,
}: {
  query: string;
  results: SearchResult[];
  // Whether more results matched than the page shows.
  more: boolean;
  context: PageContext;
}) {
  return (
    <Layout title="Search" query={query} context={context}>
      <section class="catalogue" aria-labelledby="search-title">
        <PageSearch query={query} />
        <header class="catalogue-head">
          <div>
            <h1 id="search-title" class="catalogue-title">
              {query === "" ? "Search your library" : <>Cards mentioning <em>“{query}”</em></>}
            </h1>
            <p class="catalogue-lede">
              {query === ""
                ? "Enter a word in the search field. Commonplace searches every saved page, including text outside the article content."
                : results.length === 0
                  ? `Nothing matches “${query}”. Check the spelling, or try a shorter term.`
                  : "Pulled from every page you saved, including text outside the article."}
            </p>
          </div>
          {results.length === 0 ? null : (
            <span class="stamp" data-stamp>{more ? `${results.length}+ found` : `${results.length} found`}</span>
          )}
        </header>
        {results.length === 0 ? null : (
          <ol class="catalogue-list">{results.map((result) => <ResultCard result={result} />)}</ol>
        )}
      </section>
    </Layout>
  );
}
