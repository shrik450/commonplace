import { Elysia } from "elysia";
import { join } from "node:path";
import { HomePage } from "./views/home";

export const app = new Elysia()
  .get("/health", () => ({ ok: true }))
  .get(
    "/",
    () =>
      new Response(String(HomePage()), {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
  )
  .get(
    "/app.css",
    () =>
      new Response(Bun.file(join(import.meta.dir, "..", "..", "public", "app.css"))),
  );

if (import.meta.main) {
  app.listen(Number(process.env.PORT ?? 3000));
}
