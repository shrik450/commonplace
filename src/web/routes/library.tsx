import { Elysia } from "elysia";

import { authenticate } from "../../services/auth";
import { listLibrary, searchLibrary } from "../../services/library";
import { LibraryPage } from "../views/library";
import { page } from "../views/layout";
import { SearchPage } from "../views/search";
import { authDeps, libraryDeps, preferredLocale, toLogin, type WebDeps } from "./deps";

const PAGE_SIZE = 50;
const SEARCH_LIMIT = 30;

export function libraryRoutes(deps: WebDeps) {
  return new Elysia()
    .get("/library", async ({ request }) => {
      const principal = await authenticate(request, authDeps(deps)).catch(
        () => null,
      );
      if (principal === null) return toLogin();

      const items = listLibrary(
        libraryDeps(deps),
        principal.user.id,
        PAGE_SIZE,
      );
      return page(
        <LibraryPage items={items} locale={preferredLocale(request)} />,
      );
    })
    .get("/search", async ({ request }) => {
      const principal = await authenticate(request, authDeps(deps)).catch(
        () => null,
      );
      if (principal === null) return toLogin();

      const query = new URL(request.url).searchParams.get("q") ?? "";
      const results =
        query.trim() === ""
          ? []
          : searchLibrary(
              libraryDeps(deps),
              principal.user.id,
              query,
              SEARCH_LIMIT,
            );
      return page(<SearchPage query={query} results={results} />);
    });
}
