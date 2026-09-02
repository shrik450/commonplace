import { Database } from "bun:sqlite";

import type { Config } from "../../contracts/config";
import type { LibraryDeps } from "../../services/library";

export type WebDeps = { db: Database; config: Config; now: () => Date };

export function libraryDeps(deps: WebDeps): LibraryDeps {
  return { db: deps.db, itemsRoot: deps.config.items_root };
}

export function authDeps(deps: WebDeps): {
  db: Database;
  config: Config;
  now: Date;
} {
  return { db: deps.db, config: deps.config, now: deps.now() };
}

// The reader's own date format, read from the browser rather than pinned to
// one country. An unknown or malformed tag falls back to British English,
// which is what this app shipped with.
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
    // supportedLocalesOf throws on a tag that is not well formed, and a
    // header is caller input, so a bad tag must not take the page down.
    try {
      if (Intl.DateTimeFormat.supportedLocalesOf(tag).length > 0) return tag;
    } catch {
      continue;
    }
  }
  return FALLBACK_LOCALE;
}

// Every guarded route answers a signed-out reader the same way: send them to
// the login route rather than a bare 401, because every guarded route is a
// page a person asked for.
export function toLogin(): Response {
  return new Response(null, { status: 303, headers: { location: "/login" } });
}
