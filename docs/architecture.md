# Architecture

This document defines the module layers and helps you place new code.

## Layers

The system has five layers. A module can import its own layer or a lower layer.
It can't import a higher layer.

```
L4  web/ , cli/      the two operator surfaces: HTTP and terminal
L3  services/        use cases; the only layer that composes I/O with logic
L2  store/           SQLite and the filesystem; no domain logic
L1  core/            pure functions; the whole domain, no I/O
L0  contracts/       types, error codes, and the two impure primitives
```

L1 contains pure domain logic. The sanitizer, walker, projector, and
re-anchorer accept data and return data without file, database, browser, or
clock access. Tests can reproduce their behavior with string inputs.

L2 performs database and file I/O but contains no domain logic. Put text
processing and other domain decisions in `core/`.

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

Only `ids.ts` and `clock.ts` access nondeterministic values. Other modules
receive IDs and times as inputs so tests can reproduce failures.

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

The `cp` command lets operators and automation inspect the system without a
browser. Every subcommand supports `--json`.

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

Use these commands instead of writing scripts to inspect system state.

## Errors and logs

`AppError` includes a stable machine-readable code and context object. Write
one JSON log object per line: `{ level, code, msg, ...context }`. Use the code
to search for related failures. A test rejects bare `throw new Error(...)`
statements.

## Fixtures

All fixtures live under `test/fixtures/` and belong to one of these groups:

- `test/fixtures/synthetic/` is committed. The files are small HTML fixtures
  documents that cover the hard cases: nested inline elements, tables,
  `<pre>`, HTML entities, astral-plane characters that occupy two UTF-16 code
  units, and right-to-left text. Golden transcript and map files sit beside
  each source file. These fixtures form the primary walker test suite.
- `test/fixtures/real/` is not committed and is rebuildable with
  `cp fixtures capture`. It holds a few real captures for spot checks. Real
  captures inline every resource, so they are megabytes each. Keeping them out
  of git keeps the repo small.

Golden-file differences show which fixture transcripts changed without
requiring you to inspect the walker implementation first.
