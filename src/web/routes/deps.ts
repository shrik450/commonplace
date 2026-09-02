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

// Every guarded route answers a signed-out reader the same way: send them to
// the login route rather than a bare 401, because every guarded route is a
// page a person asked for.
export function toLogin(): Response {
  return new Response(null, { status: 303, headers: { location: "/login" } });
}
