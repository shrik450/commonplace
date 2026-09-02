import { Elysia } from "elysia";
import { join } from "node:path";

import { now } from "../contracts/clock";
import { AppError } from "../contracts/errors";
import { capture } from "../services/acquire";
import { startWorker } from "../services/worker";
import { defaultConfigPath, loadConfig } from "../store/config";
import { openDatabase } from "../store/db";
import { authRoutes, logoutRoute } from "./routes/auth";
import type { WebDeps } from "./routes/deps";
import { itemRoutes } from "./routes/item";
import { itemSaveRoutes } from "./routes/items";
import { libraryRoutes } from "./routes/library";
import { settingsRoutes } from "./routes/settings";
import { HomePage } from "./views/home";
import { page } from "./views/layout";

export type { WebDeps };

const repoRoot = join(import.meta.dir, "..", "..");

// The reader script is bundled once per process, not per request. A build
// failure is a programming error, so it surfaces rather than serving a stub.
let bundled: Promise<string> | null = null;

function readerScript(): Promise<string> {
  bundled ??= Bun.build({
    entrypoints: [join(import.meta.dir, "client", "reader.ts")],
    target: "browser",
    minify: true,
  }).then((result) => {
    const output = result.outputs[0];
    if (!output) {
      throw new AppError("VIEW_SCRIPT_BUILD_FAILED", "reader.ts did not build");
    }
    return output.text();
  });
  return bundled;
}

// The routes a signed-out browser may reach: the landing page and the two
// static assets. They hold no reader's data, so they carry no guard.
export function publicRoutes() {
  return new Elysia()
    .get("/health", () => ({ ok: true }))
    .get("/", () => page(HomePage()))
    .get(
      "/app.css",
      () => new Response(Bun.file(join(repoRoot, "public", "app.css"))),
    )
    .get("/reader.js", async () => {
      return new Response(await readerScript(), {
        headers: { "content-type": "text/javascript; charset=utf-8" },
      });
    });
}

export function buildApp(deps: WebDeps) {
  return new Elysia()
    .use(publicRoutes())
    .use(authRoutes(deps))
    .use(logoutRoute())
    .use(libraryRoutes(deps))
    .use(itemSaveRoutes(deps))
    .use(settingsRoutes(deps))
    .use(itemRoutes(deps));
}

// The web server is its own entry point. `src/cli/` and `src/web/` are
// siblings, so the operator CLI cannot start the app for us.
if (import.meta.main) {
  const config = await loadConfig(defaultConfigPath());
  const db = openDatabase(join(config.db_root, "db.sqlite"), now());
  const port = Number(process.env.PORT ?? 3000);

  // One process serves and drains. A reader who saves a URL from the web has
  // no terminal to run a worker in, so the worker runs here.
  const worker = startWorker({
    db,
    itemsRoot: config.items_root,
    now,
    capture,
    browserPath: config.browser_path,
  });

  const server = buildApp({ db, config, now }).listen(port);
  console.log(JSON.stringify({ level: "info", msg: "listening", port }));

  // Stop the loop before the process leaves, so a capture in flight finishes
  // writing its file and committing its row.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      void (async () => {
        await server.stop();
        await worker.stop();
        process.exit(0);
      })();
    });
  }
}
