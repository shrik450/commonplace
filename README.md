# Commonplace

A personal reading archive. Save web articles and EPUB books, search their full
text, annotate passages, and link those annotations from your notes.

> [!NOTE]
> This repo is entirely vibecoded, and nothing after this paragraph is
> human-written.

## The model

One transcript per item, many views.

- **Item** — one thing you read. A web `article` or a `book`.
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
- **Annotation** — `(item_id, start_offset, end_offset, quote, note)`, anchored
  to character offsets in the transcript. Because the offsets index our own
  transcript, one annotation works for a book, a web page, and every view,
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
      |  acquire (out of process: abx-dl, or file read)
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
      | create: Selection + Map -> Range
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
durable inputs — sanitize, walk, index — so "copy the DB and the item dirs" is a
complete backup.

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
bind mounts, and TLS all live in `~/.config/commonplace`.

## Components

One process, one SQLite database with the FTS5 extension.

- **Ingest** — receives a URL or EPUB upload, queues a `FetchRequest`, and
  drains it in-process. Acquisition shells out to `abx-dl`, a thin, swappable
  adapter (files in, files out). The sanitizer strips every embedded script. In
  one pass, the walker emits the transcript, the Map, and content flags.
- **Store** — SQLite on one root: `items`, `annotations`, plus an FTS5 table
  over the transcripts with the content flag as a filter column. Item files live
  on the other root: `items/<id>/capture.html`, `source.epub`, `transcript.txt`,
  `map.msgpack`.
- **Viewer** — three routes per item. The reader view renders the content runs
  from the original DOM, not readability's HTML. The capture view serves the
  sanitized file with exactly one overlay script (pinned by CSS nonce). A raw
  text page shows the transcript. A single overlay script draws highlights and
  resolves selections.
- **API** — CRUD for items and annotations, search, vault export. The web UI
  calls this API; it is also the integration surface for anything else.

## Out of scope

- **PDFs.** Typeset PDFs cannot be linearized into a single transcript, so they
  break the model on purpose.
- **Progress sync and offline reading.**
