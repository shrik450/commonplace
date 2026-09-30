import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { capture } from "../../src/services/acquire";
import { browserPath } from "../support/browser";

test("captures a loaded page while a background request remains open", async () => {
  const cacheRoot = join(import.meta.dir, "..", "..", ".cache");
  await mkdir(cacheRoot, { recursive: true });
  const dir = await mkdtemp(join(cacheRoot, "acquire-"));
  const passage = "The article remains readable while its background request stays open. ".repeat(20);
  let pendingRequests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/pending") {
        pendingRequests += 1;
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("pending"));
          },
        }));
      }
      return new Response(`<!doctype html><html><head><title>Background request</title></head><body><article><h1>Background request</h1><p>${passage}</p></article><script>fetch('/pending')</script></body></html>`, {
        headers: { "content-type": "text/html" },
      });
    },
  });
  try {
    const outputPath = join(dir, "original.html");
    await capture({
      url: `http://127.0.0.1:${server.port}/`,
      browserPath: browserPath(),
      binaryPath: join(import.meta.dir, "..", "..", "node_modules", ".bin", "single-file"),
      outputPath,
      timeoutMs: 15_000,
    });
    expect(pendingRequests).toBeGreaterThan(0);
    expect(await readFile(outputPath, "utf8")).toContain(passage.trim());
  } finally {
    await server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);
