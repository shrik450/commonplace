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

Keep this dependency direction when changing code. Tests focus on behavior rather than checking the source tree.

L1 is pure on purpose. `sanitize`, `walk`, `project`, and `anchor` take strings
and return data. They never touch the filesystem, the database, or the clock.
That is what makes them testable with a string literal.

## Modules

Keep new code in the layer that owns its behavior. Add files where their use
case belongs; the test suite does not maintain a source-file allowlist.

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

## Behavioral coverage

The suite covers observable behavior, including authentication, tenant
isolation, queue lifecycle, durable files, ingest outcomes, transcript and Map
correctness, projection round trips, capture CSP, and reader behavior.

Do not add tests for source layout, imports, exact SQL or schema snapshots,
helper internals, tool output formatting, random uniqueness, or incidental
serialization. Add a behavior test when a bug affects something a reader or
operator can observe.

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

Follow the visual rules in the skill and use the shared `LINK`, `ACTION`,
`SUBMIT`, and `FIELD` constants from `src/web/views/layout.tsx`.

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
