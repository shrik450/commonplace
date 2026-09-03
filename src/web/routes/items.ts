import { Elysia } from "elysia";

import { toIso } from "../../contracts/clock";
import { AppError } from "../../contracts/errors";
import {
  isJsonObject,
  isStringValue,
  parseJsonValue,
  type JsonValue,
} from "../../contracts/item";
import { newRequestId } from "../../contracts/ids";
import { authenticate } from "../../services/auth";
import { enqueueFetch } from "../../store/queue";
import { ErrorPage, page } from "../views/layout";
import { authDeps, toLogin, userSettings, type WebDeps } from "./deps";

// Accepts form data from the library and JSON from an iOS Shortcut.
async function readUrl(request: Request): Promise<string | null> {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    let body: JsonValue;
    try {
      body = parseJsonValue(await request.text());
    } catch {
      return null;
    }
    if (!isJsonObject(body)) return null;
    const url = body.url;
    return isStringValue(url) ? url : null;
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
      // Return an HTTP 401 response to API clients instead of redirecting them
      // to the interactive sign-in flow.
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
        `"${url ?? ""}" isn't an HTTP or HTTPS URL`,
        { url: url ?? "" },
      );
      // Return JSON to API clients and a corrective page to browser clients.
      if (principal.via === "token") {
        return new Response(JSON.stringify({ error: error.code }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return page(
        ErrorPage({
          title: "Commonplace cannot save that address",
          message:
            "Enter a complete web address that starts with http:// or https://, such as https://example.com/an-essay.",
          code: error.code,
          settings: userSettings(deps, principal.user.id),
        }),
        400,
      );
    }

    // Return after enqueueing because page capture runs asynchronously in the
    // process worker.
    const queued = enqueueFetch(deps.db, {
      id: newRequestId(),
      item_id: null,
      url,
      state: "queued",
      lease_expires_at: null,
      attempts: 0,
      error_code: null,
      created_at: toIso(deps.now()),
      user_id: principal.user.id,
    });

    if (principal.via === "token") {
      return new Response(
        JSON.stringify({
          request_id: queued.id,
          state: queued.state,
          status_url: `${deps.config.base_url}/saves/${queued.id}`,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(null, {
      status: 303,
      headers: { location: `/saves/${queued.id}` },
    });
  });
}
