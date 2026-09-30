import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

import type { UserId } from "../../src/contracts/ids";
import { sessionCookie, type TestLibrary } from "./library";

// Drives the real app in a real browser. The browser tests and the
// screenshot tool use it; it never downloads a browser of its own.

const repoRoot = join(import.meta.dir, "..", "..");

export function browserPath(): string {
  const path = process.env.COMMONPLACE_TEST_BROWSER;
  if (path === undefined || path === "") {
    throw new Error("COMMONPLACE_TEST_BROWSER is unset. Run the tests inside `nix develop`, which provides Chromium.");
  }
  return path;
}

export async function launch(): Promise<Browser> {
  if (!existsSync(join(repoRoot, "public", "app.css")) || !existsSync(join(repoRoot, "public", "scripts", "index-box.js"))) {
    throw new Error("The stylesheet or scripts aren't built. Run `bun run assets` first.");
  }
  return chromium.launch({ executablePath: browserPath() });
}

export type Served = { origin: string; stop: () => void };

export function serve(library: TestLibrary): Served {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => library.app.handle(request) });
  return { origin: `http://127.0.0.1:${server.port}`, stop: () => void server.stop(true) };
}

export type Viewport = { width: number; height: number };

export const DESKTOP: Viewport = { width: 1280, height: 820 };
export const PHONE: Viewport = { width: 390, height: 780 };

export type Visit = {
  context: BrowserContext;
  page: Page;
  // Console errors and uncaught exceptions. A clean page has none.
  errors: string[];
  close: () => Promise<void>;
};

export type VisitOptions = {
  viewport?: Viewport;
  scripts?: boolean;
  reducedMotion?: "reduce" | "no-preference";
  colorScheme?: "light" | "dark";
  hasTouch?: boolean;
};

export async function visit(
  browser: Browser,
  served: Served,
  userId: UserId | null,
  options: VisitOptions = {},
): Promise<Visit> {
  const context = await browser.newContext({
    viewport: options.viewport ?? DESKTOP,
    javaScriptEnabled: options.scripts ?? true,
    reducedMotion: options.reducedMotion ?? "no-preference",
    colorScheme: options.colorScheme ?? "light",
    hasTouch: options.hasTouch ?? false,
    isMobile: options.hasTouch ?? false,
  });
  if (userId !== null) {
    const cookie = sessionCookie(userId);
    const at = cookie.indexOf("=");
    await context.addCookies([{ name: cookie.slice(0, at), value: cookie.slice(at + 1), url: served.origin }]);
  }
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return { context, page, errors, close: () => context.close() };
}
