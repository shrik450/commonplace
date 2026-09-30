import { Elysia } from "elysia";

import { parsePagePosition, type PagePosition } from "../../contracts/cursor";
import { AppError } from "../../contracts/errors";
import { authenticate } from "../../services/auth";
import { libraryPage, searchLibrary } from "../../services/library";
import { page } from "../views/layout";
import { LibraryView } from "../views/library";
import { SearchPage } from "../views/search";
import { authDeps, libraryDeps, pageContext, toLogin, type WebDeps } from "./deps";
import { errorResponse, seeOther } from "./errors";

const PAGE_SIZE = 200;
const SEARCH_LIMIT = 30;

export function libraryRoutes(deps: WebDeps) {
  return new Elysia()
    .get("/library", async ({ request }) => {
      const principal = await authenticate(request, authDeps(deps)).catch(() => null);
      if (principal === null) return toLogin();
      const context = pageContext(deps, principal.user.id, request);

      let position: PagePosition;
      try {
        position = parsePagePosition(new URL(request.url).searchParams);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        return errorResponse(
          context,
          400,
          "That library page link is broken",
          "The link names a place in your library that doesn't exist. Open your library from the top, and page from there.",
          error.code,
        );
      }

      const library = libraryPage(libraryDeps(deps), principal.user.id, position, PAGE_SIZE);
      // A page past either end, such as one whose cards were removed, starts
      // over at the newest cards.
      if (library.cards.length === 0 && position.kind !== "newest") return seeOther("/library");
      return page(<LibraryView library={library} context={context} />);
    })
    .get("/search", async ({ request }) => {
      const principal = await authenticate(request, authDeps(deps)).catch(() => null);
      if (principal === null) return toLogin();

      const query = new URL(request.url).searchParams.get("q") ?? "";
      // One result past the limit says whether there are more than it shows.
      const found = query.trim() === ""
        ? []
        : searchLibrary(libraryDeps(deps), principal.user.id, query, SEARCH_LIMIT + 1);
      return page(
        <SearchPage
          query={query}
          results={found.slice(0, SEARCH_LIMIT)}
          more={found.length > SEARCH_LIMIT}
          context={pageContext(deps, principal.user.id, request)}
        />,
      );
    });
}
