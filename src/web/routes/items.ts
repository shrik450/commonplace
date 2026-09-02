import { Elysia } from "elysia";

import { toIso } from "../../contracts/clock";
import { AppError } from "../../contracts/errors";
import { newRequestId } from "../../contracts/ids";
import { authenticate } from "../../services/auth";
import { enqueueFetch } from "../../store/queue";
import { ErrorPage, page } from "../views/layout";
import { authDeps, toLogin, type WebDeps } from "./deps";

// Two callers reach this route: the library form and an iOS Shortcut. The
// form wants the library page back, the Shortcut wants JSON, and
// `principal.via` already tells the two apart.
async function readUrl(request: Request): Promise<string | null> {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return null;
    }
    if (typeof body !== "object" || body === null) return null;
    const url = (body as Record<string, unknown>).url;
    return typeof url === "string" ? url : null;
  }
  const fields = new URLSearchParams(await request.text());
  return fields.get("url");
}

function isFetchable(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

export function itemSaveRoutes(deps: WebDeps) {
  return new Elysia().post("/items", async ({ request }) => {
    const principal = await authenticate(request, authDeps(deps)).catch(
      () => null,
    );
    if (principal === null) {
      // A Shortcut cannot follow a redirect to a login page, so a rejected
      // credential gets the status that says so.
      if (request.headers.get("authorization") !== null) {
        return new Response(
          JSON.stringify({ error: "AUTH_TOKEN_INVALID" }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }
      return toLogin();
    }

    const url = await readUrl(request);
    if (url === null || !isFetchable(url)) {
      const error = new AppError(
        "INGEST_BAD_URL",
        `"${url ?? ""}" is not an http or https URL`,
        { url: url ?? "" },
      );
      // A Shortcut reads JSON. A reader who mistyped a link deserves a page
      // that says what to type instead.
      if (principal.via === "token") {
        return new Response(JSON.stringify({ error: error.code }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return page(
        ErrorPage({
          title: "That is not a link Commonplace can save",
          message:
            "Paste a whole web address that starts with http:// or https://, such as https://example.com/an-essay.",
          code: error.code,
        }),
        400,
      );
    }

    // Enqueue and return. A capture takes tens of seconds, and the worker
    // inside this process drains the queue, so nothing here waits for it.
    const queued = enqueueFetch(deps.db, {
      id: newRequestId(),
      item_id: null,
      url,
      source_path: null,
      state: "queued",
      lease_expires_at: null,
      attempts: 0,
      error_code: null,
      created_at: toIso(deps.now()),
      user_id: principal.user.id,
    });

    if (principal.via === "token") {
      return new Response(
        JSON.stringify({ request_id: queued.id, state: queued.state }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(null, {
      status: 303,
      headers: { location: "/library" },
    });
  });
}
