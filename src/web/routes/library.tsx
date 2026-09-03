import { Elysia } from "elysia";

import { authenticate } from "../../services/auth";
import {
  listLibrary,
  listSaveRequests,
  searchLibrary,
} from "../../services/library";
import { LibraryPage } from "../views/library";
import { page } from "../views/layout";
import { SearchPage } from "../views/search";
import {
  authDeps,
  libraryDeps,
  preferredLocale,
  toLogin,
  userSettings,
  type WebDeps,
} from "./deps";

const PAGE_SIZE = 50;
const SEARCH_LIMIT = 30;
const SAVE_REQUEST_LIMIT = 10;

export function libraryRoutes(deps: WebDeps) {
  return new Elysia()
    .get("/library", async ({ request }) => {
      const principal = await authenticate(request, authDeps(deps)).catch(
        () => null,
      );
      if (principal === null) return toLogin();

      const library = libraryDeps(deps);
      const items = listLibrary(library, principal.user.id, PAGE_SIZE);
      const saveRequests = listSaveRequests(
        library,
        principal.user.id,
        SAVE_REQUEST_LIMIT,
      );
      return page(
        <LibraryPage
          items={items}
          saveRequests={saveRequests}
          locale={preferredLocale(request)}
          settings={userSettings(deps, principal.user.id)}
        />,
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
      return page(<SearchPage query={query} results={results} settings={userSettings(deps, principal.user.id)} />);
    });
}
