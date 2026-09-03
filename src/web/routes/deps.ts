import { Database } from "bun:sqlite";

import type { Config } from "../../contracts/config";
import type { LibraryDeps } from "../../services/library";

export type WebDeps = { db: Database; config: Config; now: () => Date };

export function libraryDeps(deps: WebDeps): LibraryDeps {
  return { db: deps.db, itemsRoot: deps.config.items_root };
}

export type AuthDeps = { db: Database; config: Config; now: Date };

export function authDeps(deps: WebDeps): AuthDeps {
  return { db: deps.db, config: deps.config, now: deps.now() };
}

// Format dates using the browser's preferred supported locale. Use British
// English when the header is missing or contains no valid locale.
const FALLBACK_LOCALE = "en-GB";

export function preferredLocale(request: Request): string {
  const header = request.headers.get("accept-language");
  if (header === null) return FALLBACK_LOCALE;

  const tags = header
    .split(",")
    .map((part) => {
      const [tag = "", ...rest] = part.trim().split(";");
      const quality = rest
        .map((option) => option.trim())
        .find((option) => option.startsWith("q="));
      return { tag: tag.trim(), q: quality === undefined ? 1 : Number(quality.slice(2)) };
    })
    .filter((entry) => entry.tag !== "" && entry.tag !== "*" && !Number.isNaN(entry.q))
    .toSorted((a, b) => b.q - a.q);

  for (const { tag } of tags) {
    // `supportedLocalesOf` throws for malformed tags, which are valid input to
    // reject from this untrusted header.
    try {
      if (Intl.DateTimeFormat.supportedLocalesOf(tag).length > 0) return tag;
    } catch {
      continue;
    }
  }
  return FALLBACK_LOCALE;
}

// Redirect signed-out browser requests to the interactive sign-in flow.
export function toLogin(): Response {
  return new Response(null, { status: 303, headers: { location: "/login" } });
}
