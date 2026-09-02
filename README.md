# Commonplace

A personal reading archive. Save web articles and EPUB books, search their full
text, annotate passages, and link those annotations from your notes.

> [!NOTE]
> This repo is entirely vibecoded, and nothing after this paragraph is
> human-written.

## The model

One transcript per item, many views. Every row belongs to a user — the data
model is multi-tenant from day one.

- **Item** — one thing you read. A web `article` or a `book`. Owned by the user
  who ingested it.
- **Transcript** — the item's full text as one ordered character stream in
  reading order. Built once at ingest, immutable afterward. Search, annotations,
  and citations all anchor to the transcript. It is the single source of truth
  for what the item says.
- **Map** — the run table: `(start, end, doc_index, node_path, is_content)`. It
  records which source DOM node produced each span of transcript characters.
  That gives a bidirectional mapping between transcript offsets and DOM nodes.
  For books, the walker concatenates all spine documents first, so transcript
  offsets stay global across the whole item and resolve correctly in any view.
- **View** — one rendering of the item: the raw capture, the cleaned reader
  page, raw text, or the EPUB. No view is authoritative; every view is derived
  from the transcript through the Map.
- **Annotation** — `(user_id, item_id, start_offset, end_offset, quote, note)`,
  anchored to character offsets in the transcript. Because the offsets index our
  own transcript, one annotation works for a book, a web page, and every view,
  without caring about format. The quoted string lets us re-anchor by text match
  if the file is ever replaced — and matches how ereader highlights arrive, as
  raw text.

Rules that keep the model honest:

- Sanitize before you walk. The Map's DOM references point at the sanitized
  document, the file you serve — not the raw original capture.
- Only the Map stores positions. Views hold no offsets, and the database never
  stores DOM paths.
- Readability is a heuristic, not a source of truth. Use it only to flag which
  runs are content; keep your own text in the transcript rather than adopting
  readability's cleaned HTML.

## Dataflow

```
URL / EPUB upload
      |  acquire (out of process: single-file-cli, or file read)
      v
Capture (raw SingleFile HTML)   SourceFile (EPUB)   ItemMetadata
      |  sanitize (in process)
      v
SanitizedCapture
      |  linearize (the walker, one pass)
      v
Transcript  +  Map   (fused, immutable, one directory per item)
      |                      |
      | index                | project (per request)
      v                      v
FTS rows                View HTML + highlight spans
                             ^
      Annotation --------------|
      | create: Selection + reader DOM (data-start) -> Range
      v
DB rows (items, annotations)
      |  export (rebuildable)
      v
VaultStub + symlink tree
```

The forms, by lifetime:

| Form                                        | Lifetime                | Storage |
| ------------------------------------------- | ----------------------- | ------- |
| `FetchRequest`                              | dies after ingest       | DB      |
| `Capture` (raw, unsanitized)                | durable, immutable      | file    |
| `SourceFile` (EPUB)                         | durable, immutable      | file    |
| `ItemMetadata`                              | durable, mutable        | DB      |
| `SanitizedCapture`                          | durable, immutable      | file    |
| `Transcript`                                | durable, immutable      | file    |
| `Map`                                       | durable, immutable      | file    |
| `Annotation`                                | durable, mutable        | DB      |
| Projection (views, highlights, search hits) | ephemeral, per request  | none    |
| `VaultStub` + symlinks                      | disposable, rebuildable | file    |

Keep the lifetimes apart. Projections hold no truth: rebuild them per request
and never treat them as state. Durable mutable records (item metadata,
annotations) belong in the DB and hold no positions. The immutable forms are
written once and never edited. The immutable forms can regenerate from the
durable inputs — sanitize, walk, index — so a `VACUUM INTO` snapshot plus the
item dirs is a complete backup. (With WAL mode, copying the live database file
by hand is not safe; snapshot through `VACUUM INTO` instead.)

## App/deploy split

The app owns capabilities and never assumes locations. The deployment owns
locations and never contains logic.

- The app exposes two configurable storage roots, `db` and `items`, and requires
  no co-location. Two roots allow a user to keep SQLite on fast, reliable
  storage while item files live on a large, potentially slow drive, and let
  deploy point each side at whichever filesystem suits it.
- All derived state — the FTS index, the Map, vault stubs, the symlink tree —
  rebuilds from the durable forms.
- Ingest writes across both roots in an order that is crash-safe: write files
  first, then commit the DB row, then sweep any orphans.

Nothing in the app knows where the two roots point. The app ships the
`Dockerfile` and image build; deployment configures it. Paths, socket location,
bind mounts, TLS, and the Pocket ID issuer URL with its client credentials all
live in `~/.config/commonplace`.

## Components

One process, one SQLite database with the FTS5 extension.

- **Ingest** — receives a URL or EPUB upload, queues a `FetchRequest`, and
  drains it in one worker thread (the queue is the `FetchRequest` table; jobs
  are claimed with an atomic `UPDATE ... RETURNING` and swept on startup by
  lease timeout). The worker owns its own database connection, so the query path
  never runs on the walker's thread. Acquisition shells out to
  `single-file-cli`, a thin, swappable adapter (files in, files out). The
  adapter spawns the tool rather than importing it, so a browser crash cannot
  stop the worker. It uses `--blocked-url-pattern` with regular expressions to
  remove ads and consent dialogs before capture. It passes the output path as a
  positional argument. The sanitizer removes embedded scripts. The walker emits
  the transcript, Map, and content flags in one pass.
- **Store** — SQLite on one root: `users`, `items`, `annotations`, `api_tokens`,
  plus an FTS5 table. Each FTS row is one block from the Map, carrying its
  `(start, end)` and its `is_content` flag as a filter column, so a search hit
  returns the snippet and the transcript range in one query and deep-links
  to the passage. Each row represents a paragraph-sized block rather than one
  run. Indexing by run would prevent phrase matches across inline elements such
  as `<em>`. Search indexes every block, including text hidden from the reader
  view. Item files live on the other root, under
  `items/<user_id>/<item_id>/`: `original.html`, `sanitized.html`,
  `source.epub`, `transcript.txt`, and `map.json`.
- **Viewer** — three routes per item. The reader view is the annotation surface:
  it renders only readability-classified runs, projected from the original DOM
  rather than readability's cleaned HTML, and its elements carry transcript
  offsets so a small script can turn selections into ranges. Content flags can
  be recomputed from the stored capture without moving annotations. The capture view serves the sanitized
  file unchanged as a static archive (`script-src 'none'`); showing highlights
  there is a later, additive step through the Map. A raw text page shows the
  transcript.
- **API** — CRUD for items and annotations, search, vault export. The web UI
  calls this API; it is also the integration surface for anything else.
- **CLI** — `cp`, one operator command over the same services: `doctor`,
  `ingest`, `transcript`, `map`, `search`, and `check`. Every subcommand supports
  `--json`, which lets operators and automation inspect the system without a
  browser.
- **Auth** — Pocket ID over OIDC (passkeys only), signed session cookies, and
  hashed long-lived API tokens for non-browser clients.

## Auth

Two ways in, one identity provider, no passwords anywhere.

- **Login** — the app speaks OIDC directly to Pocket ID, the way Beszel does:
  authorization code flow with PKCE, endpoints discovered from the issuer URL.
  No reverse-proxy auth layer, no tinyauth. Pocket ID's passkeys are the only
  human login. Pocket ID also gives per-app access control, so a second account
  (a partner, say) can use the reading archive without terminal access.
- **Sessions** — a successful login mints a signed session cookie (HttpOnly,
  SameSite=Lax). Every route checks it: UI, API, and the static item files. The
  overlay script carries no auth logic; it rides the same-origin cookie.
- **API tokens** — long-lived bearer tokens for non-browser clients that cannot
  do passkeys, such as iOS Shortcuts. Create them in the web UI after login;
  store only the SHA-256 hash, show the token once at creation. A token acts as
  its owner. Revoke by deleting the row.

## Locked decisions

Stack and contracts, decided up front. Details (the sanitizer allowlist, the
vault frontmatter) get baked at implementation.

- **Runtime** — Bun (pinned in the Dockerfile), TypeScript, one process. Package
  install, test runner, and bundler all come from Bun.
- **Web** — Elysia with server-rendered TSX. No SPA, no client framework, no
  client routing. Pages are per-request projections, matching the model.
- **Styling** — Tailwind CSS 4 with daisyUI for components; Fontsource variable
  fonts (Newsreader for reading, Inter for chrome); lucide icons as inline SVGs.
  Dark mode from the start. One CSS build step, `--watch` in dev.
- **Client script** — the reader view carries one small vanilla TypeScript
  script that turns selections into transcript offsets from the `data-start`
  attributes the server emits. The capture view ships with no script at all
  (`script-src 'none'`) until highlight display is added later. No client
  framework anywhere.
- **Search vs. reader view** — the reader view shows only readability-classified
  runs; search indexes every run with `is_content` as a filter column.
  Misclassification is visible in search, not silent.
- **Database** — `bun:sqlite` with FTS5, WAL mode set once at startup,
  `busy_timeout` on every connection. Every row carries a `user_id`.
- **Queue** — in-process only: the `FetchRequest` table plus one worker thread,
  one job at a time. No Redis, no external broker.
- **Offset contract** — transcript offsets count UTF-16 code units. Node paths
  address the sanitized tree, which is the file both sides parse, so the walker
  and the browser agree on the shape. The walker emits one `\n` between blocks
  and nothing between inline elements. Every annotation stores its quote so
  offsets can re-anchor by text match.
- **IDs** — UUIDv7, stored as TEXT, minted with `Bun.randomUUIDv7()`. Bun ships
  it, so the project carries no `uuid` package.
- **Sanitizer** — DOMPurify over jsdom; scripts, event handlers, and
  `javascript:` URLs always stripped.
- **Capture** — `single-file-cli`. It inlines every resource, so a capture
  renders with the network unplugged. See "Why single-file-cli" below.
- **Browser** — one Chromium, pinned by Playwright and shared by capture and
  tests. The app never guesses where it lives: config carries `browser_path`,
  and development falls back to `chromium.executablePath()`.
- **Config** — TOML at `~/.config/commonplace`: `db_root`, `items_root`,
  `base_url`, `issuer_url`, `client_id`, `client_secret`, `session_secret`.
  `base_url` is the public origin, with no trailing slash. The login redirect
  comes from it, never from the `Host` header a caller controls.
- **Backups** — `VACUUM INTO` snapshot plus the item dirs. Nothing else.
- **Layering** — five layers, imports pointing one way only: contracts, core,
  store, services, then web and cli. The whole domain lives in `core` as pure
  functions with no I/O, so every behavior is reproducible from a string
  literal. A test enforces the rule; see `docs/architecture.md`.
- **One gate** — `bun run verify` runs the type checker, the linter, and the
  tests, and prints a one-line JSON summary. It is the only definition of done.
- **Executable invariants** — tests in `test/invariants/` enforce these rules.
  Offsets cover the transcript, `core` remains pure, every row includes
  `user_id`, and the capture view includes no script.
- **Errors** — one `AppError` with a stable, namespaced code and one JSON log
  line per event. Bare `throw new Error` is banned by a test, because a
  failure should be greppable.
- **Tooling** — oxlint (oxc) for linting, `tsc --noEmit` for type checking,
  `bun test` for tests. Property tests pin the offset contract: annotate,
  project, and the highlighted text equals the quote. Browser tests drive
  Playwright's `chromium` from inside `bun test`, not `@playwright/test`: one
  test runner, not two. jsdom cannot test the selection script, because it
  implements neither the `Selection` API nor layout.

## Building it

Start with `AGENTS.md` for the layer rule, module list, commands, and enforced
invariants.

`docs/architecture.md` names every module and states the layer rule: imports
point one way, from `web` and `cli` down through `services` and `store` to
`core` and `contracts`. The whole domain lives in `core` as pure functions, so
any behavior is reproducible from a string literal.

`docs/offset-contract.md` states the offset rules exactly. Read it before
touching the walker or the projector, because a change there moves every stored
annotation.

`docs/dependencies.md` records every pinned version and why. `bunfig.toml`
rejects any package published in the last 14 days.

Run `bun run verify` to type-check, lint, and test the project. The command can
print one JSON summary line and treats unrecognized tool output as a failure.
Tests under `test/invariants/` enforce the system rules.

## Why single-file-cli

Three candidates were measured on 2026-08-27, on seven sites: Wikipedia, MDN,
react.dev, danluu.com, ciechanow.ski, the Guardian, and GitHub. Each capture was
reopened with every network request blocked. The metric is `net_fail`: requests
that still tried to leave the machine. An archive that reaches for the network
is an archive that decays.

| Capture method                 | Sites with 0 `net_fail` |
| ------------------------------ | ----------------------- |
| `single-file-cli`              | 7 of 7                  |
| `abx-dl`                       | 5 of 7                  |
| Playwright with a hand inliner | 2 of 7                  |

**abx-dl is SingleFile.** It loads the SingleFile browser extension into its own
Chromium, beside uBlock and a cookie-banner dismisser. On four targets its
output matched `single-file-cli` within 160 bytes. It lost twice. It could not
capture the Guardian at all, failing after 229 seconds with
`SingleFile download for tab did not complete`. On ciechanow.ski it returned 90
of 95 diagrams as blank white images; enabling its `infiniscroll` plugin did not
help. Its only real advantage, blocking ads and consent modals, is one
`--blocked-url-pattern` flag on the CLI. It costs a Python toolchain, a second
Chromium, and roughly 6.6 MB of scaffolding per capture. Rejected.

**A hand-written inliner is the fallback, not the plan.** About 60 lines of
Playwright — collect responses, rewrite the CSSOM, inline images and frames —
produced captures visually identical to SingleFile's on Wikipedia and react.dev.
It fails on the long tail: images that never load because they sit below the
fold, inside `display: none` menus, or belong to the inactive colour theme. It
also drops shadow DOM and writes frames without a sandbox. Each gap is a few
more lines, and you find each one by opening an old capture and seeing a broken
image.

This is why acquisition stays a swappable adapter. If `single-file-cli` is ever
abandoned, roughly 60 lines recover most of its value.

## Out of scope

- **PDFs.** Typeset PDFs cannot be linearized into a single transcript, so they
  break the model on purpose.
- **Progress sync and offline reading.**
