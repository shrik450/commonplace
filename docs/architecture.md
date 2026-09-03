# Architecture

Commonplace stores the current transcript for each saved web page. Each
capture produces the transcript and Map. They remain stable until the next
recapture of that URL. The transcript is an ordered character stream. The Map
links each span to the sanitized DOM node that produced it. The reader, search
results, and highlights project from those two files.

## Layers

Imports point down through these layers. Web and CLI are siblings.

```
L4  web/ , cli/      HTTP and operator surfaces
L3  services/        use cases and external tools
L2  store/            SQLite and item files
L1  core/             pure transcript and HTML functions
L0  contracts/        types and controlled time and ID primitives
```

Core functions do not access files, databases, browsers, clocks, or network
APIs. Store modules own I/O. Services combine store operations with domain
functions. Routes and commands stay thin.

## Modules

### Contracts

- `ids.ts` defines branded UUID types and creates IDs and secrets.
- `clock.ts` owns current time and date helpers.
- `errors.ts` defines stable application error codes and log records.
- `transcript.ts` defines runs, block grouping, range lookup, and map checks.
- `item.ts` defines users, web items, annotations, API tokens, and queue rows.
- `config.ts` parses the application configuration.

### Core

- `sanitize.ts` removes unsafe markup and owns the shared block-element list.
- `walk.ts` extracts metadata and builds the transcript and Map in one pass.
- `project.ts` renders content runs and highlight marks from the transcript.
- `anchor.ts` re-anchors a saved quote when its offsets no longer match.

### Store

- `db.ts` opens SQLite, applies migrations, and translates write errors.
- `config.ts` reads the config file and calls the contract parser.
- `items.ts` reads and updates item metadata.
- `annotations.ts` reads annotations for rendering.
- `users.ts` stores users and hashed API tokens.
- `queue.ts` owns URL ingest jobs, leases, and cleanup state.
- `fts.ts` indexes one searchable row per transcript block.
- `files.ts` atomically stores the four item files:
  `original.html`, `sanitized.html`, `transcript.txt`, and `map.json`.

### Services

- `acquire.ts` invokes `single-file-cli` and checks its output.
- `ingest.ts` acquires, sanitizes, walks, stores, and indexes a URL.
- `library.ts` loads reader data and search results.
- `auth.ts` handles OIDC, signed sessions, and API tokens.
- `worker.ts` provides queue draining, lease cleanup, and worker lifecycle.

`worker.ts` is a reusable service. It has no executable entry point. The web
server starts it in the same process because the queue is intentionally local.

### Web and CLI

The web layer renders server-side HTML for the home page, library, search,
reader, structured text, saved copy, sign-in, and token settings. It serves no
application JavaScript. The structured text view retains safe HTML semantics
and uses the transcript and Map for ordered text. The saved copy remains
authenticated, serves `original.html`, and uses a strict policy with inline CSS
and embedded data images and fonts only.

The CLI has two operator commands:

- `cp doctor` checks configuration, storage roots, the browser, and the capture
  executable.
- `cp ingest <url> --user <uuid>` captures one URL in the foreground.

## Durable data

Each item directory lives at `items/<user_id>/<item_id>/`. Each capture produces
the current transcript and Map. They remain stable until the next recapture of
that URL. A recapture reuses the item ID and replaces the four capture files.
The database stores metadata, users, tokens, annotations, and queue state.
Ingest writes files before committing the item row. A lease-aware sweep removes
abandoned directories but protects active queue reservations.

Annotations retain transcript offsets and their quote in SQLite. Rendering
re-anchors the quote against the current transcript and projects it through the
current Map. No DOM path or document position enters the database.

Schema version 2 migrates old databases by retaining only article rows with a
non-null URL. It discards book rows, incomplete article rows, their annotations
and search blocks, and legacy non-URL requests. Orphaned old item directories
are removed by the normal cleanup sweep.
