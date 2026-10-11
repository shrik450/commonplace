import { join } from "node:path";

import { ALICE, reopenLibrary, sessionCookie, type TestLibrary } from "../test/support/library";

// The demo library that `bun run preview` seeds.
export const PREVIEW_LIBRARY = join(import.meta.dir, "..", "preview", "library");

// Signs every request in as the demo reader, since the preview has no
// identity provider.
export function servePreview(library: TestLibrary, hostname = "127.0.0.1") {
  const cookie = sessionCookie(ALICE);
  const server = Bun.serve({
    port: Number(process.env.PORT ?? 8411),
    hostname,
    fetch: (request) => {
      const headers = new Headers(request.headers);
      if (!headers.has("cookie")) headers.set("cookie", cookie);
      return library.app.handle(new Request(request, { headers }));
    },
  });
  console.log(`Serving the demo library at http://${server.hostname}:${server.port}/library`);
}

// `bun run preview watch` runs this file under `bun --watch`, so a restart
// serves the library already seeded rather than seeding it again.
if (import.meta.main) servePreview(reopenLibrary(PREVIEW_LIBRARY), process.argv[2]);
