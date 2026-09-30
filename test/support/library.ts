import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addMs } from "../../src/contracts/clock";
import type { Config } from "../../src/contracts/config";
import { asUserId, newRequestId, type ItemId, type UserId } from "../../src/contracts/ids";
import type { User } from "../../src/contracts/item";
import { signPayload } from "../../src/services/auth";
import { ingestRequest } from "../../src/services/ingest";
import { openDatabase } from "../../src/store/db";
import { claimRequest, enqueueFetch } from "../../src/store/queue";
import { insertUser } from "../../src/store/users";
import { buildApp } from "../../src/web/server";

// A real library on disk, filled through the real ingest path with a capture
// that writes fixed HTML instead of driving a browser. Acceptance tests, the
// browser tests, and the screenshot tool all build on it.

export const ALICE = asUserId("11111111-1111-4111-8111-111111111111");
export const BOB = asUserId("22222222-2222-4222-8222-222222222222");
const SESSION_SECRET = "x".repeat(32);

export type TestLibrary = {
  root: string;
  db: Database;
  itemsRoot: string;
  config: Config;
  app: ReturnType<typeof buildApp>;
  // Every item saved from here on is created this long after the previous one.
  clock: { now: Date };
  close: () => Promise<void>;
};

function user(id: UserId, subject: string): User {
  return { id, subject, email: null, created_at: "2026-01-01T00:00:00.000Z" };
}

export async function openLibrary(name: string, rootDir?: string): Promise<TestLibrary> {
  const root = rootDir ?? await mkdtemp(join(tmpdir(), `commonplace-${name}-`));
  await mkdir(root, { recursive: true });
  const db = openDatabase(join(root, "db.sqlite"), new Date("2026-01-01T00:00:00.000Z"));
  insertUser(db, user(ALICE, "alice"));
  insertUser(db, user(BOB, "bob"));
  const itemsRoot = join(root, "items");
  await mkdir(itemsRoot, { recursive: true });
  const config: Config = {
    db_root: root,
    items_root: itemsRoot,
    base_url: "https://read.example.com",
    issuer_url: "https://id.example.com",
    client_id: "client",
    client_secret: "secret",
    session_secret: SESSION_SECRET,
    browser_path: "/usr/bin/chromium",
  };
  const clock = { now: new Date("2026-05-01T09:00:00.000Z") };
  return {
    root,
    db,
    itemsRoot,
    config,
    app: buildApp({ db, config, now: () => clock.now }),
    clock,
    close: async () => {
      db.close();
      if (rootDir === undefined) await rm(root, { recursive: true, force: true });
    },
  };
}

export function sessionCookie(userId: UserId): string {
  return `cp_session=${signPayload(SESSION_SECRET, {
    user_id: userId,
    exp: addMs(new Date(), 3_600_000).toISOString(),
  })}`;
}

// Saves `html` as the page at `url`, a minute after the previous save.
export async function savePage(
  library: TestLibrary,
  owner: UserId,
  url: string,
  html: string,
): Promise<ItemId> {
  library.clock.now = addMs(library.clock.now, 60_000);
  const at = library.clock.now;
  const queued = enqueueFetch(library.db, {
    id: newRequestId(),
    user_id: owner,
    item_id: null,
    url,
    state: "queued",
    lease_expires_at: null,
    attempts: 0,
    error_code: null,
    created_at: at.toISOString(),
  });
  const claimed = claimRequest(library.db, queued.id, at, 60_000)!;
  const outcome = await ingestRequest(
    {
      db: library.db,
      itemsRoot: library.itemsRoot,
      now: () => at,
      capture: async (request) => {
        await Bun.write(request.outputPath, html);
        return { path: request.outputPath, bytes: html.length };
      },
      browserPath: "/unused",
    },
    claimed,
  );
  if (outcome.state !== "done") throw new Error(`fixture ingest failed: ${outcome.code}`);
  return outcome.itemId;
}

export type Article = { title: string; author?: string; paragraphs: string[]; aside?: string };

export function articleHtml(article: Article): string {
  const author = article.author === undefined ? "" : `<meta name="author" content="${article.author}">`;
  const aside = article.aside === undefined ? "" : `<nav><p>${article.aside}</p></nav>`;
  return `<html><head><title>${article.title}</title>${author}</head><body>` +
    `<article><h1>${article.title}</h1>${article.paragraphs.map((text) => `<p>${text}</p>`).join("")}</article>` +
    `${aside}</body></html>`;
}

export function get(library: TestLibrary, path: string, userId: UserId | null = ALICE): Promise<Response> {
  const headers = new Headers();
  if (userId !== null) headers.set("cookie", sessionCookie(userId));
  return library.app.handle(new Request(`http://localhost${path}`, { headers }));
}

export function postForm(
  library: TestLibrary,
  path: string,
  fields: Record<string, string>,
  userId: UserId | null = ALICE,
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
  if (userId !== null) headers.set("cookie", sessionCookie(userId));
  return library.app.handle(new Request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: new URLSearchParams(fields).toString(),
  }));
}
