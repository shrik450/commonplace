# Commonplace — agent guide

Read this file first. It is the map of the repo and the rules of the road.
Read `README.md` for why the system is shaped this way. Read the files in
`docs/` when you touch the area they cover. Read `docs/design.md` before you
change anything under `src/web/`; it fixes the look of every page.

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
  core/        sanitize.ts walk.ts epub.ts project.ts anchor.ts search.ts
  store/       db.ts config.ts items.ts annotations.ts users.ts queue.ts fts.ts files.ts
  services/    acquire.ts ingest.ts worker.ts library.ts annotate.ts export.ts auth.ts
  web/         server.ts routes/ views/ client/reader.ts
  cli/         main.ts
scripts/       verify.ts               (tooling; the layer rule does not apply)
```

`test/invariants/module-list.test.ts` enforces this list. A file under `src/`
that is not listed fails the gate. Adding a module is a deliberate decision, so
raise it rather than inventing one.

## Commands

| Command | What it does |
| ------- | ------------ |
| `bun run verify` | Type check, lint, and test. The one gate. |
| `bun run verify --json` | The same, as one JSON summary line on stdout. |
| `bun run verify:browser` | The Playwright tests. Slow. |
| `bun run cp <sub>` | The operator CLI. See `bun run cp --help`. |
| `bun run cp doctor` | Check config, roots, browser path, and database health. |
| `bun run serve` | Run the web app. Reads the config; `PORT` overrides 3000. |
| `bun run css` | Build `public/app.css`. Add `:watch` for development. |
| `docker build -t commonplace .` | Build the image. Pins Bun and installs Chromium. |
| `docker run` | Run it. Mount the config at `/home/bun/.config/commonplace/config.toml`, mount `/data/db` and `/data/items`, publish 3000. |

`bun run verify` is the definition of done. Nothing else counts.

In `--json` mode, stdout holds exactly one line. The raw output of any failing
tool goes to stderr, so a failure is diagnosable without a second run.

**The gate fails closed.** A step passes only when the tool exits 0 and its
output parses clean. When the two disagree, the step fails. A tool that crashes
must never be reported as a pass. Never make a check pass by ignoring an exit
code or by defaulting a count to zero.

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

All ten exist today, and two more ride alongside them: `route-guard`, which
makes every route call `authenticate` or appear on the unguarded list, and
`branded-ids`, which makes every id parameter and field carry its brand. Never
write an invariant test that passes because it checks nothing.

Every invariant is a pure checker function in `test/invariants/lib.ts`. Each
checker has two tests: one that runs it over the real repo, and one that runs
it over a known-bad input and asserts it fails. A checker without the second
test is worthless, because nobody knows it can fail.

When you fix a bug that no invariant caught, add an invariant test for it.

## Acceptance tests are the specification

The files under `test/acceptance/` state what a piece of work must do. They
are written before the work starts. Make them pass.

Do not edit an acceptance test to make your own code pass. That is the one
forbidden edit, and a reviewer reads every diff that touches these files.

Do change one when the design changes. A specification written before the work
can be wrong, and an assertion that cannot pass helps nobody. When you change
one, say in your report which assertion moved and why. Let the design evolve
when it needs to.

## Errors

Throw `AppError` from `src/contracts/errors.ts`. Every error carries a stable
code, namespaced by module: `CONFIG_*`, `STORE_*`, `WALK_*`, `INGEST_*`,
`AUTH_*`, `VIEW_*`, `EXPORT_*`. Logs are one JSON object per line. A code makes
a failure greppable, so never throw a bare string.

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
