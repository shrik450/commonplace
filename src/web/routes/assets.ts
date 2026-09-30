import { Elysia } from "elysia";
import { join } from "node:path";

import { isClientScript } from "../client/scripts";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const publicDir = join(repoRoot, "public");

const FONT_FILES = new Set<string>([
  "newsreader-latin-opsz-normal.woff2",
  "newsreader-latin-opsz-italic.woff2",
  "literata-latin-opsz-normal.woff2",
  "literata-latin-opsz-italic.woff2",
  "source-serif-4-latin-opsz-normal.woff2",
  "source-serif-4-latin-opsz-italic.woff2",
  "atkinson-hyperlegible-next-latin-wght-normal.woff2",
  "atkinson-hyperlegible-next-latin-wght-italic.woff2",
  "jetbrains-mono-latin-wght-normal.woff2",
  "jetbrains-mono-latin-wght-italic.woff2",
]);

const NOT_FOUND = () => new Response("Not found", { status: 404 });

// Serves the built stylesheet and scripts, the fonts, and the icons. None of
// these expose library data, so none require authentication.
export function assetRoutes() {
  return new Elysia()
    .get("/icon.svg", () => new Response(Bun.file(join(publicDir, "icon.svg")), {
      headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" },
    }))
    .get("/favicon.svg", () => new Response(Bun.file(join(publicDir, "favicon.svg")), {
      headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" },
    }))
    .get("/app.css", () => new Response(Bun.file(join(publicDir, "app.css")), {
      headers: { "content-type": "text/css; charset=utf-8" },
    }))
    .get("/scripts/:file", ({ params }) => {
      const name = params.file.endsWith(".js") ? params.file.slice(0, -3) : "";
      if (!isClientScript(name)) return NOT_FOUND();
      return new Response(Bun.file(join(publicDir, "scripts", `${name}.js`)), {
        headers: { "content-type": "text/javascript; charset=utf-8" },
      });
    })
    .get("/fonts/:file", ({ params }) => {
      if (!FONT_FILES.has(params.file)) return NOT_FOUND();
      return new Response(Bun.file(join(publicDir, "fonts", params.file)), {
        headers: {
          "cache-control": "public, max-age=86400",
          "content-type": "font/woff2",
        },
      });
    });
}
