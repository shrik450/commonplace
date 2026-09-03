import { describe, expect, test } from "bun:test";

import { asAnnotationId, asItemId, asTokenId, asUserId } from "../../src/contracts/ids";
import type { Annotation, ApiToken, Item } from "../../src/contracts/item";
import type { SearchResult } from "../../src/services/library";
import { HomePage } from "../../src/web/views/home";
import { ErrorPage } from "../../src/web/views/layout";
import { LibraryPage } from "../../src/web/views/library";
import { ReaderPageView } from "../../src/web/views/reader";
import { SearchPage } from "../../src/web/views/search";
import {
  NewTokenPage,
  RevokeTokenPage,
  SettingsPage,
} from "../../src/web/views/settings";
import { checkUiGuidelines } from "./lib";

const userId = asUserId("2f1b1f7a-0c4a-4c4e-9a4a-3f4b1a7c9d21");
const itemId = asItemId("8c7f2a11-5d3e-4b6a-8f21-9b0c4d5e6f70");

const item: Item = {
  id: itemId,
  user_id: userId,
  url: "https://example.com/on-reading",
  title: "On reading slowly",
  author: "A Writer",
  created_at: "2026-08-14T09:30:00.000Z",
  ingested_at: "2026-08-14T09:31:00.000Z",
};

const annotation: Annotation = {
  id: asAnnotationId("1d2c3b4a-5e6f-4a7b-8c9d-0e1f2a3b4c5d"),
  user_id: userId,
  item_id: itemId,
  start_offset: 10,
  end_offset: 24,
  quote: "reading slowly",
  note: "the whole point",
  created_at: "2026-08-14T10:00:00.000Z",
  updated_at: "2026-08-14T10:00:00.000Z",
};

const token: ApiToken = {
  id: asTokenId("7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d"),
  user_id: userId,
  name: "iPhone Shortcut",
  token_hash: "a".repeat(64),
  created_at: "2026-07-01T08:00:00.000Z",
  last_used_at: null,
};

const hit: SearchResult = {
  item,
  block_index: 4,
  start_offset: 120,
  end_offset: 134,
  is_content: false,
  snippet: [
    { text: "the point of ", hit: false },
    { text: "reading slowly", hit: true },
    { text: " is to notice", hit: false },
  ],
};

// The reader injects a captured page. The checker skips that subtree, so this
// fixture carries the kind of markup we cannot fix: a link with no text.
const capturedHtml =
  '<div class="cp-transcript"><p class="cp-block">A captured paragraph.' +
  '<a href="https://example.com"><img src="/pixel.gif"></a></p></div>';

const locale = "en-GB";

function pages(): { page: string; html: string }[] {
  return [
    { page: "home", html: String(HomePage()) },
    { page: "library (empty)", html: String(LibraryPage({ items: [], locale })) },
    { page: "library", html: String(LibraryPage({ items: [item], locale })) },
    { page: "search (blank)", html: String(SearchPage({ query: "", results: [] })) },
    { page: "search (no hits)", html: String(SearchPage({ query: "ink", results: [] })) },
    { page: "search", html: String(SearchPage({ query: "reading", results: [hit] })) },
    { page: "settings (empty)", html: String(SettingsPage({ tokens: [], locale })) },
    { page: "settings", html: String(SettingsPage({ tokens: [token], locale })) },
    {
      page: "new token",
      html: String(NewTokenPage({ name: "iPhone Shortcut", secret: "cp_" + "k7Qz".repeat(8) })),
    },
    {
      page: "revoke token",
      html: String(RevokeTokenPage({ token, locale })),
    },
    {
      page: "error",
      html: String(
        ErrorPage({
          title: "We cannot find that page",
          message: "Nothing in your library has that address.",
        }),
      ),
    },
    {
      page: "error (with code)",
      html: String(
        ErrorPage({
          title: "Signing in is not available",
          message: "Wait a minute, then try again.",
          code: "AUTH_DISCOVERY_FAILED",
          href: "/login",
          linkLabel: "Try signing in again",
        }),
      ),
    },
    {
      page: "reader",
      html: String(
        ReaderPageView({
          item,
          html: capturedHtml,
          annotations: [annotation],
          locale,
        }),
      ),
    },
  ];
}

describe("ui-guidelines invariant", () => {
  test("every rendered page follows the rules a machine can check", () => {
    expect(checkUiGuidelines(pages())).toEqual([]);
  });

  test("checkUiGuidelines flags a control with no name, focus, or hover", () => {
    const violations = checkUiGuidelines([
      { page: "bad", html: "<html lang=\"en\"><body><h1>T</h1><button></button></body></html>" },
    ]);
    const rules = violations.map((violation) => violation.rule);
    expect(rules).toContain("control-name");
    expect(rules).toContain("focus-state");
    expect(rules).toContain("hover-state");
  });

  test("checkUiGuidelines flags an input with no autocomplete or ellipsis", () => {
    const violations = checkUiGuidelines([
      {
        page: "bad",
        html:
          '<html lang="en"><body><h1>T</h1>' +
          '<input name="q" aria-label="Search" placeholder="Search" ' +
          'class="hover:text-primary focus-visible:ring-1"></body></html>',
      },
    ]);
    const rules = violations.map((violation) => violation.rule);
    expect(rules).toContain("autocomplete");
    expect(rules).toContain("placeholder");
  });

  test("checkUiGuidelines flags a viewport that blocks zoom", () => {
    const violations = checkUiGuidelines([
      {
        page: "bad",
        html:
          '<html lang="en"><head><meta name="viewport" ' +
          'content="width=device-width, user-scalable=no"></head>' +
          "<body><h1>T</h1></body></html>",
      },
    ]);
    expect(violations.map((violation) => violation.rule)).toContain("viewport");
  });

  test("checkUiGuidelines flags straight quotes and three dots", () => {
    const violations = checkUiGuidelines([
      {
        page: "bad",
        html: '<html lang="en"><body><h1>T</h1><p>Saving... the "thing"</p></body></html>',
      },
    ]);
    const details = violations
      .filter((violation) => violation.rule === "typography")
      .map((violation) => violation.detail);
    expect(details).toHaveLength(2);
  });

  test("checkUiGuidelines skips the captured page it cannot fix", () => {
    const clean =
      '<html lang="en"><body><h1>T</h1><div data-cp-projected>' +
      '<a href="/x"><img src="/y.gif"></a><p>Saving...</p></div></body></html>';
    const rules = checkUiGuidelines([{ page: "reader", html: clean }]).map(
      (violation) => violation.rule,
    );
    expect(rules).not.toContain("control-name");
    expect(rules).not.toContain("img-alt");
    expect(rules).not.toContain("typography");
  });
});
