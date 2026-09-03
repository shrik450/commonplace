# Commonplace — agent guide

Read this file first for repository structure and development rules. Read
`README.md` for the system rationale. Read the relevant file in `docs/` before
you change its area. Read `docs/design.md` before you change `src/web/`.

## The model in one paragraph

One transcript per item, many views. The transcript is the item's full text as
one ordered character stream in reading order. The Map records which sanitized
DOM node produced each span of transcript characters. Search hits, annotations,
and rendered pages are all projections through the Map. Only the Map stores
positions. Nothing else does.

## Layers

Code sits in five layers. A module imports from lower layers and from its own
layer, never from a higher one. `web` and `cli` are siblings, and neither may
import the other.

| Layer | Directory | May import from | I/O allowed |
| ----- | --------- | --------------- | ----------- |
| L0 | `src/contracts/` | nothing | no |
| L1 | `src/core/` | L0 | no |
| L2 | `src/store/` | L0, L1 | yes |
| L3 | `src/services/` | L0, L1, L2 | yes |
| L4 | `src/web/`, `src/cli/` | L0–L3 | yes |

`src/web/` and `src/cli/` are siblings. Neither imports the other.

`test/invariants/layers.test.ts` enforces this rule. When you do not know where
new code belongs, the layer rule decides for you.

L1 is pure on purpose. `sanitize`, `walk`, `project`, and `anchor` take strings
and return data. They never touch the filesystem, the database, or the clock.
That is what makes them testable with a string literal.

## Module list

```
src/
  contracts/   ids.ts clock.ts errors.ts transcript.ts item.ts config.ts
  core/        sanitize.ts walk.ts project.ts anchor.ts
  store/       db.ts config.ts items.ts annotations.ts users.ts queue.ts fts.ts files.ts
  services/    acquire.ts ingest.ts worker.ts library.ts auth.ts
  web/         server.ts routes/ views/
  cli/         main.ts
```

`test/invariants/module-list.test.ts` enforces this list. Before you add a file
under `src/`, propose the module-list change for review.

## Commands

| Command | What it does |
| ------- | ------------ |
| `bun run verify` | Type check, lint, and test. The one gate. |
| `bun run cp doctor` | Check config, roots, browser path, and capture tool. |
| `bun run cp ingest <url> --user <uuid>` | Capture one URL in the foreground. |
| `bun run serve` | Run the web app. Reads the config; `PORT` overrides 3000. |
| `bun run css` | Build `public/app.css`. Add `:watch` for development. |
| `docker build -t commonplace .` | Build the image. Pins Bun and installs Chromium. |
| `docker run` | Run it. Mount the config at `/home/bun/.config/commonplace/config.toml`, mount `/data/db` and `/data/items`, publish 3000. |

Run `bun run verify` before you report that a change is complete.

The gate passes only when every command exits with code 0. Read the command
output to diagnose a failure.

## Hard invariants

Each rule below has a test in `test/invariants/`. Never weaken a test to make
your change pass.

1. `layers` — no module imports from a higher layer, and `web` and `cli` do
   not import each other. A module may import from its own layer.
2. `purity` — nothing in `src/core/` imports `node:fs`, `bun:sqlite`, or the
   layers above it, and nothing there reaches I/O through a Bun global such as
   `Bun.file` or `fetch`.
3. `module-list` — every file under `src/` appears in the module list above.
4. `offsets` — Map runs start at 0, are sorted, contiguous, and non-overlapping,
   and the last run's `end` equals `transcript.length`.
5. `round-trip` — projecting any content range and reading the highlighted text
   returns exactly `transcript.slice(start, end)`.
6. `tenancy` — every table has a `user_id` column, except `migrations`,
   `users` (which is the tenant table, so `users.id` is the tenant id), the
   tables SQLite owns under the `sqlite_` prefix, and the five shadow tables
   of an FTS5 virtual table.
7. `no-positions-in-db` — no column holds a position inside a document. The
   checker holds the exact expected column set of every table, so any column
   it does not know about fails, whatever the column is named. Transcript
   offsets are not document positions; DOM paths belong only in the Map.
8. `capture-csp` — the capture route sends `script-src 'none'` and its body
   contains no `<script`.
9. `error-codes` — no `throw new Error(`. Throw `AppError` with a code.
10. `determinism` — no direct `Date.now()`, `new Date()`, `Date.parse()`,
    `Date.UTC()`, `Math.random()`, `crypto.randomUUID()`, or
    `Bun.randomUUIDv7()` outside `src/contracts/clock.ts` and
    `src/contracts/ids.ts`. Build and read times through `clock.ts`, which
    exports `now`, `addMs`, `toIso`, `parseIso`, and `isBefore`.
11. `ui-guidelines` — every rendered page passes the machine-checkable web
    interface rules: one `h1` with no skipped levels, an accessible name on
    every control, a visible `focus-visible` style and a `hover` style on
    every link and button, `autocomplete` and a name on every field, an
    ellipsis at the end of every placeholder, `aria-hidden` or a name on
    every icon, `alt` and a size on every image, a `theme-color`, a viewport
    that allows zoom, and curly quotes instead of straight ones. The checker
    skips the subtree marked `data-cp-projected`, because a captured page's
    markup is not ours to fix.

Two additional invariants also run. `route-guard` requires every route to call
`authenticate` or appear in the public-route list. `branded-ids` requires every
ID parameter and field to use its branded type. Every invariant test must prove
that its checker rejects a known violation.

Each invariant is a pure checker in `test/invariants/lib.ts`. Test each checker
against the repository and a known invalid input. The invalid case proves that
the checker can fail.

When you fix a bug that no invariant caught, add an invariant test for it.

## Acceptance tests are the specification

The files under `test/acceptance/` state what a piece of work must do. They
are written before the work starts. Make them pass.

Don't edit an acceptance test only to make an implementation pass. Reviewers
inspect every change to these files.

Change an acceptance test when the approved design changes. In your report,
identify the changed assertion and explain why the specification changed.

## Errors

Throw `AppError` from `src/contracts/errors.ts`. Every error carries a stable
code, namespaced by module: `CONFIG_*`, `STORE_*`, `WALK_*`, `INGEST_*`,
`AUTH_*`, `VIEW_*`, and `EXPORT_*`. Logs contain one JSON object per line. Use
the code to search for related failures, and never throw a bare string.

## Ids

Ids are branded types, not strings. `src/contracts/ids.ts` exports `UserId`,
`ItemId`, `AnnotationId`, `TokenId`, and `RequestId`, each with a `new*`
constructor and an `as*` validator. The brand exists only at compile time, so
it costs nothing at runtime.

Use them everywhere an id appears, including function parameters. Every id is a
UUID, so a swapped user id and item id is a valid UUID in the wrong position:
without the brands the type checker cannot see the mistake, and the tenancy
guarantee is only as good as the argument order.

`as*` is the only way to turn an untrusted string into an id. Call it once, at
the boundary where a request parameter or a database row arrives, and pass the
branded value inward from there.

## Changes to the UI

Read `.claude/skills/web-design-guidelines/SKILL.md` before you touch anything
under `src/web/`. It is the gate for user interface work, and it has two
halves.

The `ui-guidelines` invariant provides the automated check. `bun run verify`
runs it. Interactive state lives in the `class` attribute as Tailwind utilities,
never in a CSS component class, because that is what the checker reads. Use
the shared `LINK`, `ACTION`, `SUBMIT`, and `FIELD` constants from
`src/web/views/layout.tsx` rather than writing a new class string.

Complete the manual check against
`.claude/skills/web-design-guidelines/references/web-interface-guidelines.md`,
the vendored copy of the Vercel Web Interface Guidelines. A machine
cannot see layout, contrast, or whether a sentence makes sense. Where those
rules disagree with `docs/design.md`, `docs/design.md` wins.

## Rules for changes

- Never add a dependency on your own. `bunfig.toml` pins exact versions and
  rejects anything published in the last 14 days, so an install that fails on
  age is the rule working, not a bug to route around. Audit a new package
  before it lands: publish history, maintainer count, install scripts, and the
  size of its transitive tree.
- Use a hard cutover. Do not write compatibility shims or fallback paths.
- Name things for what they do, never for what they replaced. A function that
  replaces `get_user_info` is not `get_user_info_v2`.
- Keep comments rare. Name things well instead.
