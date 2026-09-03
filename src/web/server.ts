import { Elysia } from "elysia";
import { join } from "node:path";

import { now } from "../contracts/clock";
import { capture } from "../services/acquire";
import { startWorker } from "../services/worker";
import { defaultConfigPath, loadConfig } from "../store/config";
import { openDatabase } from "../store/db";
import { authRoutes, logoutRoute } from "./routes/auth";
import type { WebDeps } from "./routes/deps";
import { itemRoutes } from "./routes/item";
import { itemSaveRoutes } from "./routes/items";
import { saveRoutes } from "./routes/save";
import { libraryRoutes } from "./routes/library";
import { settingsRoutes } from "./routes/settings";
import { HomePage } from "./views/home";
import { page } from "./views/layout";

export type { WebDeps };

const repoRoot = join(import.meta.dir, "..", "..");

// These routes don't expose library data and don't require authentication.
export function publicRoutes() {
  return new Elysia()
    .get("/health", () => ({ ok: true }))
    .get("/", () => page(HomePage()))
    .get(
      "/app.css",
      () => new Response(Bun.file(join(repoRoot, "public", "app.css"))),
    );
}

export function buildApp(deps: WebDeps) {
  return new Elysia()
    .use(publicRoutes())
    .use(authRoutes(deps))
    .use(logoutRoute())
    .use(libraryRoutes(deps))
    .use(itemSaveRoutes(deps))
    .use(settingsRoutes(deps))
    .use(itemRoutes(deps))
    .use(saveRoutes(deps));
}

// Keep server startup in the web layer because the CLI and web layers can't
// import each other.
if (import.meta.main) {
  const config = await loadConfig(defaultConfigPath());
  const db = openDatabase(join(config.db_root, "db.sqlite"), now());
  const port = Number(process.env.PORT ?? 3000);

  // Run the web server and ingest worker in the same process.
  const worker = startWorker({
    db,
    itemsRoot: config.items_root,
    now,
    capture,
    browserPath: config.browser_path,
  });

  const server = buildApp({ db, config, now }).listen(port);
  console.log(JSON.stringify({ level: "info", msg: "web server listening", port }));

  // Stop the server, then wait for the worker to finish its active ingest.
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
