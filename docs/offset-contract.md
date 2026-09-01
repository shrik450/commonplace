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
`{ start, end, doc_index, block_index, node_path, is_content }`.

1. The first run starts at 0.
2. Runs are sorted by `start`.
3. Each run's `start` equals the previous run's `end`. Runs never overlap and
   never leave a gap.
4. The last run's `end` equals `transcript.length`.
5. `start` is inclusive. `end` is exclusive.
6. `doc_index` is the index of the source document. A web article has one
   document, so `doc_index` is always 0. A book has one document per spine
   entry, numbered in spine order.
7. `block_index` groups runs into paragraph-sized blocks. It starts at 0, never
   decreases, and skips no value. Runs that share a `block_index` are always
   contiguous, which is what lets search store one row per block with one
   `(start, end)` range.

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

The walker emits text in document order. One rule governs the separator.

> The walker emits a separator `\n` at the moment a block is about to emit its
> first character, and only when the transcript is not empty and does not
> already end with `\n`.

The separator run carries the `node_path`, `block_index`, and `is_content` of
the **previous** block, not the block it precedes. A block's own range therefore
starts at its first character, never one before it. That matters: a leading
separator would make every whole-paragraph highlight store an offset one too
low, and it would corrupt annotations silently.

Three consequences follow, and none needs its own rule. The transcript never
starts with a separator, because the transcript is empty then. It never ends
with one, because nothing follows the last block. A `pre` block that ends with
`\n` swallows the separator that would follow it.

Other emitters:

- `<br>` emits one `\n`, carrying the `br` element's own `node_path` and the
  `block_index` and `is_content` of the block it sits in. A `br` is not a block
  and never takes an index of its own.
- `<br><br>` yields `\n\n`. The second break is meaningful markup, and the
  "never two in a row" rule governs separators, not a break's own newline.
- Replaced elements such as `<img>` emit nothing.
- Inline elements emit nothing of their own.

**The transcript never starts or ends with `\n`, whatever produced it.** A `br`
that would emit the first character emits nothing, because there is nothing to
break. When the walk finishes, the walker drops every trailing `\n`, shrinking
the last run and removing it when it empties. Both rules apply before block
indices are assigned, so a block left with no characters takes no index and
leaves no hole.

The one exception is the join between two chapters. When the walker starts at a
non-zero offset it emits a separator before its first character, so the last
word of one chapter does not glue to the first word of the next.

The block element list is an explicit array in `src/core/walk.ts`. It is not
computed from CSS. `body` is not on it, so the body emits no separator of its
own, but text sitting directly in the body still belongs to the body's block and
takes an index.

## Whitespace

Collapse every run of ASCII whitespace to one space. A block never begins or
ends with a space.

**Collapse across the whole block, not inside one text node.** HTML's normal
white-space processing collapses across inline boundaries. In
`<p>a <img alt="d"> b</p>` the image emits nothing, and the space on either side
of it is one run of whitespace, so the transcript holds `a b` with one space.
Collapsing each text node on its own gives two, and that is wrong.

**Emit no zero-length run.** A text node that collapses to nothing produces no
run at all, because `validateMap` rejects a run whose `end` does not exceed its
`start`.

**Hold trailing whitespace back.** You cannot know a space is trailing until the
block closes. Hold the last emitted space and release it only when the block
emits its next character. Emitting a run and shrinking it afterwards leaves a
zero-length run in the Map.

Inside `<pre>`, preserve whitespace exactly, including newlines, and do not trim
the block's edges. A preserved indent is text the reader needs. The HTML parser
already drops a single newline directly after a `<pre>` start tag, so do not
drop a second one.

The rule applies to the text as parsed, so `&nbsp;` is U+00A0, which is not
ASCII whitespace and therefore never collapses.

## Content flags

`is_content` marks whether a run belongs to the article body.

Readability returns its article as an HTML **string**, not a node, and it mutates
the document you hand it. So there is no "element readability chose" to test
ancestry against. Compute the flags in three steps instead.

1. Deep-clone the sanitized document. Stamp every element in the clone with a
   `data-cp-path` attribute holding its `node_path`.
2. Run readability over the clone. It keeps unknown attributes, so the article
   HTML it returns still carries `data-cp-path` on the elements it kept.
3. Collect those paths into a set. A run is content when its `node_path`, or any
   prefix of it, is in that set.

The clone exists only inside the walker. `data-cp-path` never reaches the
sanitized file the server stores.

**When readability returns no article, every run in the body is content.** That
is the rule, not a fallback. A short document readability declines to score is
still a document the reader must be able to read.

**`is_content` is uniform within a `block_index`.** Compute the flag for the
block and give every run in it the same value. The search index stores one flag
per block, so a mixed block has nowhere to put the disagreement.

Never adopt readability's cleaned HTML as text. It is a heuristic that flags
runs; the transcript is ours.

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
