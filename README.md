# Commonplace

Commonplace is a personal archive for saved web pages. It keeps a local copy,
extracts searchable text, and renders highlights from the current transcript.

## The model

Each capture produces the current transcript and Map. They remain stable until
the next recapture of that URL. The transcript is the full text in reading
order. The Map records which node in the sanitized capture produced each
transcript span.

Search and reader pages project from the transcript and Map. A recapture reuses
the item ID and replaces the four capture files. An annotation stores a
transcript range and its quote. The reader re-anchors the quote before
rendering, so changed offsets do not silently move a highlight.

Only the Map stores DOM positions. The database stores no DOM paths.

## Data flow

```
URL
  │
  ▼
SingleFile capture → sanitize → walk → transcript + Map
                                      │          │
                                      ▼          ▼
                                  FTS blocks  reader projection
                                      │
                                      ▼
                                  search page
```

Ingest writes these four files under
`items/<user_id>/<item_id>/`:

- `original.html` — the captured page.
- `sanitized.html` — the safe page served by the archive.
- `transcript.txt` — the current text stream.
- `map.json` — the current transcript-to-DOM Map.

SQLite stores users, item metadata, annotations, API token hashes, and the
queue. The database and item files can live on separate configured roots.
Ingest writes files before it commits the item row. A lease-aware sweep removes
abandoned directories while protecting active work.

Schema version 2 migrates old databases by retaining only article rows with a
non-null URL. It discards book rows, incomplete article rows, their annotations
and search blocks, and legacy non-URL requests. Orphaned old item directories
are removed by the normal cleanup sweep.

## Product surface

The web app provides:

- a public landing page and health endpoint;
- OIDC sign-in with signed, secure session cookies;
- a library and full-text search;
- URL saving from the library or an API token;
- a reader, raw transcript, and authenticated sanitized capture;
- API token creation and revocation.

The reader uses server-rendered HTML. It ships no application JavaScript. The
capture route sends `script-src 'none'` and the sanitizer removes scripts.

Annotations remain renderable from stored rows. Annotation creation is not
exposed until there is a complete selection-to-save flow.

## Security and isolation

Every stored row belongs to a user, except the tenant table and SQLite-owned
tables. Every request authenticates before reading library data. Bearer tokens
identify their owner, even when a request also carries another session cookie.
Token secrets are shown once and only their SHA-256 hashes are stored.

OIDC discovery must return same-origin HTTPS endpoints for the configured
issuer. Login uses authorization code flow with PKCE. Redirect URLs come from
`base_url`, never from the request Host header.

## Running it

Install the pinned dependencies, then build the stylesheet:

```sh
bun install
bun run css
```

Run the checks with:

```sh
bun run verify
```

Run the app with `bun run serve`. Run `bun run cp doctor` to check the config,
storage roots, browser, and capture executable. Capture one URL with:

```sh
bun run cp ingest https://example.com/article --user <user-uuid>
```

The config lives at `~/.config/commonplace/config.toml`, unless
`XDG_CONFIG_HOME` changes that root. It names `db_root`, `items_root`,
`base_url`, OIDC settings, `session_secret`, and the required
`browser_path` to the Chromium executable used for capture.

Build the image with `docker build -t commonplace .`. Mount the config at
`/home/bun/.config/commonplace/config.toml`, mount `/data/db` and
`/data/items`, and publish port 3000.

## Design boundaries

Bun runs the server, CLI, database, and tests. TypeScript code is split into
contracts, pure core functions, stores, services, and thin web and CLI layers.
`bun run verify` runs `tsc`, `oxlint`, and the three test groups directly.

The system supports web pages only. PDFs, EPUB files, progress sync, and
offline reading are not implemented because they need different product
contracts.
