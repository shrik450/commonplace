# Architecture

This document names every module and the rule that orders them. Use it to
decide where new code belongs.

## The tower

The system is one tower of five layers. Truth flows up. Dependencies point
down. No module ever imports sideways or upward.

```
L4  web/ , cli/      the two operator surfaces: HTTP and terminal
L3  services/        use cases; the only layer that composes I/O with logic
L2  store/           SQLite and the filesystem; no domain logic
L1  core/            pure functions; the whole domain, no I/O
L0  contracts/       types, error codes, and the two impure primitives
```

Two properties make this tower legible.

First, **L1 holds the entire domain and touches nothing**. The sanitizer, the
walker, the projector, and the re-anchorer take strings and return data. Any
behavior worth arguing about is reproducible from a string literal in a test.
No fixture path, no database, no browser.

Second, **L2 holds no domain logic**. It moves rows and bytes. If a function in
`store/` decides something about text, it belongs in `core/`.

## Modules

### L0 `src/contracts/`

| File | Holds |
| ---- | ----- |
| `ids.ts` | UUIDv7 minting through `Bun.randomUUIDv7()`, injectable for tests |
| `clock.ts` | `now()`, injectable for tests |
| `errors.ts` | `AppError` and the code union |
| `transcript.ts` | `Transcript`, `Run`, `TranscriptMap` types and range helpers |
| `item.ts` | `Item`, `ItemMetadata`, `Annotation`, `User`, `ApiToken` types |
| `config.ts` | the `Config` type and a pure TOML parser; reading the file is L2 |

`ids.ts` and `clock.ts` are the only places non-determinism enters. Everything
else takes them as arguments. That is what makes a failing test reproduce.

### L1 `src/core/`

| File | Signature, in words |
| ---- | ------------------- |
| `sanitize.ts` | raw HTML → sanitized HTML |
| `walk.ts` | sanitized documents → `{ transcript, map }` in one pass |
| `epub.ts` | spine documents in order → the concatenated document list |
| `project.ts` | sanitized document, map, ranges → view HTML with `data-start` |
| `anchor.ts` | quote plus stale offsets → repaired offsets |
| `search.ts` | user query → FTS5 query string; hit rows → snippets |

### L2 `src/store/`

| File | Owns |
| ---- | ---- |
| `db.ts` | the connection, WAL mode, `busy_timeout`, and migrations |
| `config.ts` | reads the config file from disk and hands the text to L0 to parse |
| `items.ts` | the `items` table |
| `annotations.ts` | the `annotations` table |
| `users.ts` | the `users` and `api_tokens` tables |
| `queue.ts` | `fetch_requests`: claim, complete, and sweep by lease |
| `fts.ts` | FTS5 writes and reads |
| `files.ts` | the item directory layout, atomic writes, and the orphan sweep |

### L3 `src/services/`

| File | Use case |
| ---- | -------- |
| `acquire.ts` | the `single-file-cli` adapter; spawns the tool, files in, files out |
| `ingest.ts` | the worker: acquire, sanitize, walk, write files, commit the row |
| `library.ts` | item create, read, update, delete |
| `annotate.ts` | annotation create, read, update, delete |
| `export.ts` | vault stubs and the symlink tree |
| `auth.ts` | OIDC with PKCE, session cookies, API tokens |
| `worker.ts` | the ingest worker thread entry point; owns its own connection |

### L4 `src/web/` and `src/cli/`

`web/` is Elysia with server-rendered TSX. `cli/` is the `cp` operator command.
Both are thin. Neither holds logic that a service could hold. Neither imports
the other.

## The operator CLI

`cp` is not a convenience. It is the introspection surface that makes the
running system observable without a browser, and it doubles as the operator
tool the app needs anyway. Every subcommand accepts `--json`.

| Command | Prints |
| ------- | ------ |
| `cp doctor` | config, both roots, browser path, `single-file-cli`, database health |
| `cp ingest <url or file>` | runs one ingest in the foreground, prints the item id |
| `cp items` | the item list |
| `cp transcript <item> [--range A:B]` | transcript text, whole or sliced |
| `cp map <item> [--offset N]` | the runs, or the one run covering an offset |
| `cp search <query>` | hits with their transcript ranges |
| `cp check <item>` | runs every invariant against one real item |
| `cp fixtures capture` | refreshes the real-page corpus under `test/fixtures/real/` |

Without it, anyone who needs to see system state writes a throwaway script.

## Errors and logs

`AppError` carries a stable machine code and a context object. Log one JSON
object per line: `{ level, code, msg, ...context }`. A code turns a failure
report into a one-command search. Bare `throw new Error(...)` is banned by a
test.

## Fixtures

Two kinds, for two jobs.

All fixtures live under `test/fixtures/`. There is no second root.

- `test/fixtures/synthetic/` is committed. The files are tiny, hand-written HTML
  documents that cover the hard cases: nested inline elements, tables,
  `<pre>`, HTML entities, astral-plane characters that occupy two UTF-16 code
  units, and right-to-left text. Golden transcript and map files sit beside
  each one. These run in milliseconds and are the walker's real test suite.
- `test/fixtures/real/` is not committed and is rebuildable with
  `cp fixtures capture`. It holds a few real captures for spot checks. Real
  captures inline every resource, so they are megabytes each. Keeping them out
  of git keeps the repo small.

A golden diff is a compact signal. "The walker changed the transcript of four
synthetic fixtures" is one line that tells me to look hard, without reading any
walker code.
