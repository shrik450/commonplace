# Visual design

Read this document before you change `src/web/`. It defines one visual system
for every page. The stack uses Tailwind CSS 4, one stylesheet per material
object, self-hosted reading fonts, system interface text, inline Lucide SVG
icons, and two themes.

## Design direction

Commonplace is a desk with a few well-made objects on it: an index box of
cards, a commonplace book of clippings, and sheets of paper to read. The look
is material and a little playful, in the spirit of classic Apple software and
the 37signals apps, but it stays a web page first. Skeuomorphism is
inspiration, never friction: every object still scrolls, links, and focuses
the way a web page does.

Reason physically. Before you draw an object, ask what the real one looks like
from this angle, in this light. Every rejected design so far broke that
consistency: a lip that sat over the sides of the box, a stack of card edges
seen from above, a black interior that read as a window.

## Light and depth

- Light comes from one source above the desk.
- A raised object gets two shadows: a tight contact shadow and a wide, faint
  ambient one. Use the `--lift-1`, `--lift-2`, and `--lift-3` tokens for the
  three heights. Never invent a shadow in a component.
- Paper has thickness: a lit top edge and a slightly darker bottom edge, the
  `--paper-edge` token.
- Depth comes from light, edges, and stacking order, not texture. Objects have
  no glossy or lit gradients.
- Texture appears in two places only: the fine weave on book cloth, and a faint
  grain on paper.

## Themes

Parchment is daylight on a warm desk. Ink is the same desk at night under a
lamp. Both themes use the same tokens, defined once in
`src/web/styles/tokens.css` with `light-dark()`. The theme setting only picks
`color-scheme`, so a component never checks which theme is active.

Shadows barely read on a dark surface, so ink carries depth in two other ways:
top edges catch the lamp, and a surface gets lighter as it rises (desk, box,
card, lifted card).

| Role | Parchment | Ink |
| ---- | --------- | --- |
| Desk | `#EFE7D8` | `#14151A` |
| Paper | `#FFFAF0` | `#23242C` |
| Lifted paper | `#FFFDF7` | `#2A2B34` |
| Body text | `#2A241D` | `#E6E2DA` |
| Muted text | `#6E675E` | `#A39CAD` |
| Hairline rule | `#E2DACD` | `#33343E` |
| Accent | `#B4522F` | `#D97A4E` |
| Highlight wash | `rgba(214, 148, 61, 0.28)` | `rgba(217, 155, 78, 0.24)` |
| Book cloth | `#AB4B2B` | `#6A2A18` |
| Brass | `#C29952` | `#9A7C45` |
| Manila | `#ECDCB6` | `#3D3629` |

Follow these color rules:

- The highlight is a translucent wash, so overlapping highlights deepen and the
  text under them stays readable. Never use a solid yellow block.
- Muted text is for metadata only: dates, hosts, counts, authors.
- Use the accent for one primary element at a time. Cloth, brass, and manila
  are materials, not accents.

## Type

- Use Newsreader for transcript text, titles, and the brand. Use system sans
  serif for interface text. Account settings can choose Newsreader, Literata,
  Source Serif 4, Atkinson Hyperlegible Next, system sans serif, system
  monospace, or JetBrains Mono for reading. Sliders control size, line
  spacing, paragraph spacing, and text width.
- Self-host the Latin variable fonts as WOFF2 files. Use each font's system
  category as its fallback.
- Every size and weight is a step of the scale in `tokens.css`. Never write a
  size or a weight as a number in a stylesheet. Add a step only when a new
  kind of text can't take an existing one.

  | Step | Size | Set in | Used for |
  | ---- | ---- | ------ | -------- |
  | `micro` | 11px | interface | stamps, counts, folios |
  | `caption` | 12px | interface | dates, sources, small links |
  | `label` | 13px | interface | field labels, bylines, chips |
  | `control` | 14px | interface | buttons, tabs, ledes |
  | `body` | 15px | interface | prose on a sheet |
  | `plain` | 16px | either | fields, notes, excerpts |
  | `quote` | 18px | reading | clippings, search snippets |
  | `heading` | 20px | reading | card titles, the brand, book headings |
  | `title` | 30px | reading | sheet titles, and every large title on a phone |
  | `display` | 40px | reading | the reader's, the book's, and the search page's title |

  Weights are `medium` (500) for display type and card titles, `heading`
  (600) for titles, `label` (650) for interface text that must stand out,
  and `stamp` (800) for small capitals. Regular is the default.
- The transcript alone sizes itself. Its text follows the reading settings,
  and its headings are multiples of that size.
- Italic is for a reader's own words and for excerpts: notes, card excerpts,
  the book's title page. It is not used for emphasis in interface text.
- The reading column holds about 68 characters. Set it with `max-width`, in
  `ch`, not with a pixel width.

## Layout

- Every page that holds one object uses one width, `--page-w`: the reader's
  measure plus the sheet's margins. The index box, the reader sheet, search,
  and forms share it, so changing the text width moves them together. The open
  book is the deliberate exception.
- The top bar is a strip of the desk. The brand sits on the left, the main
  views hang from the top edge as tabs, and search is a paper slip. The
  Library tab carries the card count.
- The index box and the commonplace book fill the window. The page does not
  scroll; the object scrolls or turns inside itself.
- A skip link sits before the top bar. It is invisible until it takes focus.

## Objects

### Index box

The library is a box of index cards seen from the front and above. Cards stand
packed, each overlapping the one behind it, and lower on screen is nearer to
you. At rest a card shows its title, its clippings and page notes marks, and its date. Pulling
a card, by hover or keyboard focus, tips the cards in front of it forward and
shows what is printed below: an excerpt, the site, the author, the reading
time, and the clippings and page notes counts. The pulled card stays where it stood, so the
card behind it is still in reach. Where the front pile leaves no room below
it, the card and the cards behind it rise together.

Cards you have scrolled past lean against the back wall, and cards still ahead
lean against the front. Each pile shows how many cards it holds, compressed so
a large library stays readable. A card folds into a pile as it crosses the
pile's edge. The piles count the whole library, not only the loaded cards.

The box scrolls through the whole library. Nearing either end of the loaded
cards loads the next page of them, and the cards in view don't move when it
arrives. The address names the first card in view, so reloading the library,
or coming back to it, opens the box there. Guide cards at either end lead to
the newer and older pages; they show only without a script, or when a page
fails to load.

Pending and failed saves are cards at the front of the first page. A save's
status page leads to removing it.

### Commonplace book

Clippings are kept in a cloth-bound book: two pages when the window is wide,
one when it is narrow. Each clipping is a deckle-edged scrap, taped or clipped
in, under the title of the page it came from. A page note is written, not cut
from print: a square-cut slip of note paper, taped in after the page's
clippings. Pages turn with a real leaf. Without a script, the book is one
scrolling page.

### Sheet

Reading, settings, forms, and messages sit on a sheet of paper on the desk.
The reader's sheet has a folded corner, a ribbon bookmark with its count of
clippings and page notes, and numbered marks in the margin beside each
clipping. Notes on the page as a whole are written at the end of the sheet,
under a rule, above the form for another. "Remove page…" closes the sheet.

Clipping never leaves the page. Selecting a passage offers "Clip it" and "Add
a note". A note is written on a slip laid just below the passage, which stays
washed while the slip is open. Saving marks the passage where it stands, and
the reader keeps their place. In the book, a note is written or edited on the
clipping itself, and the same form leads to removing the clipping. A page note
is edited the same way, on its slip. Without a script, each clipping and page
note has a page of its own for both.

### Catalogue

Search results are cards with the matched words in the highlight wash, under a
rubber stamp with the result count.

## Components

- `src/web/views/controls.ts` exports the class names that carry control
  states: `LINK` for a quiet link, `ACTION` for a normal action, `SUBMIT` for
  the one primary action on a page, and `FIELD`, `SELECT_FIELD`, and
  `RANGE_FIELD` for inputs. `src/web/styles/controls.css` defines their hover,
  active, and focus states in one place. Use the constants.
- Every control shows three states beyond rest: hover, active, and focus.
  Focus draws a 2 pixel accent outline, offset by 2 pixels, and only for the
  keyboard, through `:focus-visible`. Never remove an outline without drawing
  one back.
- Icons are inline Lucide SVGs at 16 or 20 pixels. An icon sits beside a
  label, except where space forces an icon alone: then it needs an accessible
  name. The phone search button and settings button are the two cases today.
- Confirm destructive actions on a separate page. End the link to that page
  with an ellipsis. Name the affected item, explain the result, and place the
  confirm and cancel actions together.

## Motion

Objects move the way their material would, briefly.

| Motion | Duration |
| ------ | -------- |
| Colour and opacity changes | 150ms |
| A tab, card, or corner settling | 180 to 300ms, with a small overshoot |
| A card folding into a pile | Tied to scrolling, never timed |
| A page turning | 650ms |

With `prefers-reduced-motion`, nothing moves: states change instantly and
pages turn without a leaf. Animate `transform`, `translate`, and `opacity`
only.

## Scripts

Every page works without a script. Scripts enhance an object that already
works: they add the piles and the fold, the page turns, and the selection
pop-up. A script writes state as data attributes and measurements as unitless
custom properties. It never writes a colour, shadow, or transform: the object's
stylesheet draws everything.

## Words

- Write to one reader, in the second person. "Your library", not "the user's
  library".
- Say what went wrong and what to do next. An error that names only the
  problem is unfinished.
- Name the action in the button: "Save page", not "Save"; "Create token", not
  "Create".
- Use sentence case for every heading and button. This project rule overrides
  the Web Interface Guidelines rule for title case.
- Use an ellipsis character, curly quotes, and a real middle dot. Never `...`
  or a straight quote.
- Format every date with `Intl`, in the reader's own locale. `preferredLocale`
  in `src/web/routes/deps.ts` reads it from the `Accept-Language` header, and
  the route passes it to the view. Wrap the result in `<time datetime>`.
- End every placeholder with an ellipsis, and show the shape of the answer.

## What to avoid

- Texture beyond the cloth weave and the paper grain.
- Gradients that pretend to be light on an object's surface.
- A second accent hue, or color as the only way to convey meaning.
- Scroll snapping in the index box. It fights the piles.
- Any layout that makes the transcript share horizontal space with a panel.
  Notes and search sit above or below the text, never beside it.
