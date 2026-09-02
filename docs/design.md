# Visual design

Read this document before you change `src/web/`. It defines a consistent visual
system for every page. The stack uses Tailwind CSS 4, daisyUI, Newsreader for
reading, Inter for interface text, inline Lucide SVG icons, and dark mode.

## Design direction

Commonplace uses a reading-focused layout instead of a dashboard layout. Light
mode uses warm neutral colors. Dark mode uses blue-black colors with a subtle
violet tone. A muted terracotta accent identifies links, active states, and
highlights. Use thin rules and whitespace for structure. Don't use cards,
boxed sections, or shadows.

## Color

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

Follow these color rules:

- The highlight is a translucent wash, so overlapping highlights deepen and
  the text under them stays readable. Never use a solid yellow block.
- Muted text is for metadata only: dates, hosts, counts, authors.
- Use the accent for one primary element at a time. Use neutral styles for
  competing elements.

## Type

- Use Newsreader for transcript text and Inter for interface text.
- Fontsource is not installed yet, so declare both families with fallbacks:
  `Newsreader, "Iowan Old Style", Palatino, Georgia, serif` and
  `Inter, system-ui, sans-serif`. Add the packages later as a deliberate
  decision, not as a side effect of a styling change.
- The reading column holds about 68 characters. Set it with `max-width`, in
  `ch`, not with a pixel width.
- Set transcript body text to `1.125rem` with a `1.7` line height. Make captured
  headings smaller than the page title.

## Layout

- The reader is one centred column. A narrow gutter on its left holds
  annotation marks, so a mark never pushes the text sideways.
- The library is a dense list, one row per item: title, then host and date in
  muted text. No cards, no thumbnails, no grid.
- Keep the top bar compact and sticky. Include only the app name, search field,
  settings link, sign-out link, and theme toggle.
- A skip link sits before the top bar. It is invisible until it takes focus.
- Separate sections with one hairline rule. Do not box them.

## Components

- Use an underlined text button for a secondary action. Reserve the filled
  accent button for the primary action on a page.
- Search hits show the block snippet with the matched words in the accent
  colour, and link straight to the transcript range in the reader.
- Icons are inline lucide SVGs at 16 or 20 pixels, and they always sit beside
  a label. An icon alone is never a control.
- Confirm destructive actions on a separate page. End the link to that page
  with an ellipsis. Name the affected item, explain the result, and place the
  confirm and cancel actions together.
- Every control shows three states beyond rest: hover, active, and focus.
  Hover and active change colour only. Focus draws a 2 pixel accent outline,
  offset by 2 pixels, and only for the keyboard, through `:focus-visible`.
  Never remove an outline without drawing one back.
- `src/web/views/layout.tsx` exports the four class strings that carry these
  states: `LINK` for a quiet link, `ACTION` for a normal action, `SUBMIT` for
  the one primary action on a page, and `FIELD` for a text input. Use them.
  They stay in the `class` attribute so the `ui-guidelines` invariant can read
  them.

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

- Card grids, drop shadows, and rounded boxes stacked inside each other.
- A second accent hue, a gradient, or color as the only way to convey meaning.
- Animation beyond a 150ms colour or opacity change.
- Any layout that makes the transcript share horizontal space with a panel.
  Notes and search sit above or below the text, never beside it.
