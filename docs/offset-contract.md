# The offset contract

Every feature in this app anchors to transcript offsets. This document is the
exact contract. Change it only with a deliberate decision, because a change
here moves every stored annotation.

## Units

Offsets count UTF-16 code units, the same unit JavaScript's `String.length`
uses. A character outside the Basic Multilingual Plane, such as an emoji,
counts as two. The browser and the walker both use this unit, so both agree
without conversion.

## Run invariants

The Map is an array of runs. Each run is
`{ start, end, doc_index, node_path, is_content }`.

1. The first run starts at 0.
2. Runs are sorted by `start`.
3. Each run's `start` equals the previous run's `end`. Runs never overlap and
   never leave a gap.
4. The last run's `end` equals `transcript.length`.
5. `start` is inclusive. `end` is exclusive.
6. `doc_index` is the index of the source document. A web article has one
   document, so `doc_index` is always 0. A book has one document per spine
   entry, numbered in spine order.

Rules 1 to 4 mean the runs tile the transcript exactly. A test checks this for
every fixture and for random generated documents.

## Node paths

`node_path` addresses the **sanitized** document, which is the file the server
stores and serves. Both the walker and the browser parse that same file, so
both see the same tree.

The format is a slash-separated list of child indices, counted from
`document.documentElement`, over all child nodes including text nodes. The path
`1/0/3` means: the second child of `documentElement`, then its first child,
then that node's fourth child.

The database never stores a node path. Only the Map file does.

## Separators

The walker emits text in document order with these rules.

- Between two block elements, emit exactly one `\n`.
- Between inline elements, emit nothing.
- `<br>` emits one `\n`.
- Replaced elements such as `<img>` emit nothing.
- Never emit two `\n` in a row, and never start the transcript with one.

An emitted `\n` is part of a run. Its run carries the `node_path` of the block
element that produced it, and copies that element's `is_content` flag. This
keeps the tiling rule true.

The block element list is an explicit array in `src/core/walk.ts`. It is not
computed from CSS.

## Whitespace

Inside a text node, collapse every run of ASCII whitespace to one space, the
way HTML normal white-space processing does. Inside `<pre>`, preserve
whitespace exactly. Drop leading and trailing whitespace at block boundaries,
so a block never begins or ends with a space.

## Content flags

`is_content` marks whether a run belongs to the article body. Compute it by
running readability over the sanitized document, then mapping its verdict onto
the ancestor chain of each run's node. Never adopt readability's cleaned HTML
as text. Readability is a heuristic that flags runs; the transcript is ours.

The flags recompute from the stored capture at any time. Annotations never move
when the flags change.

## The round trip

This property is the acceptance test for the whole model.

> Take any range `(a, b)` that lies inside content runs. Project the reader
> view with that range highlighted. Read the text inside the highlight
> elements. It equals `transcript.slice(a, b)`.

The reader view renders only content runs, so the property is stated for
content ranges. A range that crosses a non-content run is projected as the
content parts it covers, in order.

## Re-anchoring

Every annotation stores its `quote`. If a stored offset no longer matches the
quote, search the transcript for the quote and move the offsets to the nearest
match. This is how highlights arriving from an ereader, which carry text and no
offsets, enter the system.
