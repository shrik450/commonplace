---
name: web-design-guidelines
description: Review UI against the Web Interface Guidelines before it ships. Use for any change under src/web/, and when asked to review the UI, check accessibility, audit the design, or check focus, hover, forms, or copy.
metadata:
  source: https://github.com/vercel-labs/web-interface-guidelines
  vendored: 2026-09-02
---

# Web design guidelines

Review every change under `src/web/` with an automated check and a manual
check.

## Read these first, in this order

1. `docs/design.md` fixes the look of the app: colour, type, layout, and
   components. It wins on every visual choice.
2. `references/web-interface-guidelines.md` fixes behaviour: accessibility,
   focus, forms, motion, and copy. It wins on every behaviour choice.
3. `AGENTS.md` fixes the layers, the invariants, and the writing style.

When the two guideline files disagree, follow `docs/design.md` and note the
conflict in the review. One example: the guidelines ask for Title Case on headings and
buttons, and this app uses sentence case throughout.

## Run the machine gate

```
bun run verify
```

The `ui-guidelines` invariant renders every page and checks the rules a
machine can check. Read `test/invariants/ui-guidelines.test.ts` for the list.
The automated check can't assess layout, contrast, or copy clarity. Complete
the manual review after the command passes.

## Review the code

Read every file the change touches under `src/web/`. Check each rule in
`references/web-interface-guidelines.md`. Skip the React rules; this app
renders JSX to a string on the server and ships one small client script. Map
them to their HTML equivalents:

| Guideline says | Here it means |
| -------------- | ------------- |
| `onKeyDown` handlers | Use a real `<button>` or `<a>`, which is already keyboard-reachable. |
| `<Link>` | A plain `<a href>`. |
| `useState` and URL sync | State already lives in the URL, because every page is a GET. |
| Hydration safety | No hydration. Check `src/web/client/reader.ts` for the same class of bug. |
| Virtualize long lists | Page the query in the route instead. |

## Report findings

Group by file. One line each, `file:line - finding`. State the issue and the
fix. No preamble.

```text
## src/web/views/library.tsx

src/web/views/library.tsx:52 - input has no label → add aria-label
src/web/views/library.tsx:56 - button has no focus-visible ring
```

End with `✓ pass` for a file with nothing to report.

## Refresh the vendored rules

This repository vendors the rules so reviews work offline and use a stable
version. Refresh it on purpose:

```
curl -sSfL https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md
```

Copy the body into `references/web-interface-guidelines.md`, keep the
provenance comment at the top, and update the `vendored` date above. Never run
the upstream installer CLI.
