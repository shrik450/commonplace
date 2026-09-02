# The visual design

Read this before you touch anything under `src/web/`. It fixes the look of the
app so every page reads as one system. The README fixes the stack: Tailwind CSS
4, daisyUI, Newsreader for reading, Inter for chrome, lucide icons as inline
SVGs, dark mode from the start. This document fixes the choices the stack
leaves open.

## The idea in one paragraph

Commonplace is a reading archive, so it should feel like paper and ink, not
like a dashboard. Light mode is warm parchment. Dark mode is a blue-black ink
with a faint violet cast, never neutral grey. One accent, a muted terracotta,
carries links, the active state, and the highlight wash. Structure comes from
hairline rules and whitespace, never from cards, borders on four sides, or
shadows.

## Colour

Define both themes as daisyUI themes in `src/web/styles.css`. Use these values.
Do not add a second accent hue.

| Role | Light (parchment) | Dark (ink) |
| ---- | ----------------- | ---------- |
| Page background | `#F7F3EC` | `#14151A` |
| Raised surface | `#FFFDF8` | `#1A1B22` |
| Body text | `#23201C` | `#E6E2DA` |
| Muted text | `#6E675E` | `#9B94A6` |
| Hairline rule | `#E2DACD` | `#2A2B34` |
| Accent | `#B4522F` | `#D97A4E` |
| Highlight wash | `rgba(214, 148, 61, 0.28)` | `rgba(217, 155, 78, 0.24)` |

Rules for colour:

- The highlight is a translucent wash, so overlapping highlights deepen and
  the text under them stays readable. Never use a solid yellow block.
- Muted text is for metadata only: dates, hosts, counts, authors.
- The accent marks one thing at a time on a page. When two elements both want
  it, one of them is wrong.

## Type

- Transcript text uses Newsreader. Chrome uses Inter.
- Fontsource is not installed yet, so declare both families with fallbacks:
  `Newsreader, "Iowan Old Style", Palatino, Georgia, serif` and
  `Inter, system-ui, sans-serif`. Add the packages later as a deliberate
  decision, not as a side effect of a styling change.
- The reading column holds about 68 characters. Set it with `max-width`, in
  `ch`, not with a pixel width.
- Transcript body text is 1.125rem with a line height of 1.7. Headings inside
  a transcript step down gently; a captured `h1` must not shout louder than
  the page title.

## Layout

- The reader is one centred column. A narrow gutter on its left holds
  annotation marks, so a mark never pushes the text sideways.
- The library is a dense list, one row per item: title, then host and date in
  muted text. No cards, no thumbnails, no grid.
- The top bar is slim and sticky. It holds the app name, the search field, and
  the theme toggle, and nothing else.
- Separate sections with one hairline rule. Do not box them.

## Components

- Buttons are quiet. Use a text button with an accent underline for a normal
  action, and reserve a filled accent button for the one primary action on a
  page.
- Search hits show the block snippet with the matched words in the accent
  colour, and link straight to the transcript range in the reader.
- Icons are inline lucide SVGs at 16 or 20 pixels, and they always sit beside
  a label. An icon alone is never a control.

## What to avoid

- Card grids, drop shadows, and rounded boxes stacked inside each other.
- A second accent hue, a gradient, or a colour that carries meaning on its own.
- Animation beyond a 150ms colour or opacity change.
- Any layout that makes the transcript share horizontal space with a panel.
  Notes and search sit above or below the text, never beside it.
