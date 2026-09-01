# Dependencies

Every package here passed an audit before it landed. This file records what we
pin, why, and when to look again.

## Rules

**Pin exact versions.** No `^`, no `~`. A range is an unreviewed future install.
`bunfig.toml` sets `exact = true`, so `bun add` cannot write a range by accident.

**Nothing younger than 14 days.** `bunfig.toml` sets
`install.minimumReleaseAge = 1209600`. Bun filters out any version published
more recently when it resolves a range, for direct and transitive packages
alike. A stolen publish token shows up as a fresh release, so age is a cheap
filter that works even when nobody is watching.

**The rule filters ranges. It does not block an exact version you name.**
Tested on 2026-09-01: `bun add dompurify@^3.4.0` installed 3.4.13 and skipped
the 12-day-old 3.4.14, while `bun add dompurify@3.4.14` installed 3.4.14. That
is the right behavior, because naming a version is an explicit override, but it
is not what "filters out any version" suggests. So: run `bun add <package>`
with no version and let the resolver pick. `exact = true` then writes the aged
version as a hard pin. Name a version only when you mean to override the rule,
and write down why, the way the `@types/bun` note below does.

One package is exempt, through `minimumReleaseAgeExcludes`: `@types/bun` must
track the runtime version. It ships only `.d.ts` files and runs no install
script.

**Audit before the first install.** The rules above are automatic. They do not
replace reading the registry metadata for a package we have never used: publish
history, maintainer count, install scripts, and the size of the transitive
tree.

## Current set

| Package | Pinned | Why this version | Re-check |
| ------- | ------ | ---------------- | -------- |
| `elysia` | 1.4.29 | 1.4.30 was 5 days old at audit; 1.4.29 has aged | when 1.4.30 passes 14 days |
| `tailwindcss` | 4.3.3 | 46 days old, three maintainers, zero deps | on next major |
| `@tailwindcss/cli` | 4.3.3 | same release train as `tailwindcss` | on next major |
| `daisyui` | 5.7.17 | 5.7.18 to 5.7.22 shipped in one week; that burst has not settled | when the cadence returns to normal |
| `oxlint` | 1.79.0 | 1.80.0 was 7 days old at audit | when 1.80.0 passes 14 days |
| `typescript` | 7.0.2 | 54 days old, seven maintainers under Microsoft | on next minor |
| `single-file-cli` | 2.1.3 | 2.6.4 and ten more shipped in one week; 2.1.3 predates the burst | on 2026-09-14, when 2.6.4 ages out |
| `@types/bun` | 1.4.0 | matches the Bun 1.4.0 runtime; see the note below | with each Bun upgrade |
| `jsdom` | 30.0.1 | 33 days old, six maintainers, and the only DOM the other two work against | on next major |
| `dompurify` | 3.4.13 | 28 days old; 3.4.14 was 12 days old at audit | when 3.4.14 passes 14 days |
| `@mozilla/readability` | 0.6.0 | zero dependencies, three maintainers, Mozilla's repository | on next release |
| `@types/jsdom` | 30.0.0 | types only, no scripts, matches jsdom 30 | with each jsdom bump |

## Rejected

- `@elysiajs/html` — it drags in a 17-package tree, including `yargs` and
  `chalk`, to do something Bun already does. Bun compiles TSX itself, and an
  Elysia handler can return a `Response` holding a string.
- `@kitajs/html` — rejected for a specific reason, not for size. It escapes
  children **only** when you pass a `safe` attribute. Read
  `index.js` line 498 in version 4.2.13:
  `contentsToString(children, hasAttrs && attrs.safe)`. Escaping is opt-in, so
  one forgotten attribute on a page that renders an annotation note is a
  cross-site scripting hole. We want the opposite default.

  We write our own runtime in `src/web/views/jsx-runtime.ts`. It escapes every
  interpolated value, and `raw()` is the single, greppable opt-out. It does not
  hand-roll the hard part: the escaping itself calls `Bun.escapeHTML`, the same
  native function `@kitajs/html` uses when it detects Bun. So we take the
  well-tested escaper and supply only the default-safe wiring, which is about
  forty lines and fully tested.

- `linkedom` — rejected because **DOMPurify fails open against it**. The audit
  recommended linkedom for its smaller tree, 16 packages against jsdom's 37,
  and for not reading the filesystem at import. A spike overturned that.
  Running DOMPurify against a linkedom window returns `isSupported: undefined`
  and hands back the input unchanged, script tag and all. It does not throw and
  does not warn, so every test downstream would report success while the
  sanitizer did nothing.

  Two parser differences rule it out on their own. linkedom uses `htmlparser2`,
  which does not implement HTML tree construction. It does not insert the
  implied `tbody` inside a `table`, and it does not drop the newline after a
  `<pre>` start tag. Both make the walker's tree disagree with the browser's,
  and `node_path` addresses the browser's tree.

- `parse5` alone, with a sanitizer of our own — rejected. Its tree is correct
  and its dependency count is the lowest of the set, but Readability needs a
  DOM, so a DOM library is required anyway. Writing our own HTML sanitizer to
  replace DOMPurify means owning the mutation-XSS bypass classes DOMPurify
  already tracks, and that is not a fixed amount of work. `parse5` still
  arrives in the tree, inside `jsdom`.

## Notes on the risky picks

**`@types/bun` 1.4.0 is fresh, and I pinned it anyway.** The audit says hold.
I overrode it for one reason: the older 1.3.14 does not describe the Bun 1.4.0
runtime we use, so it would hide real type errors and invent fake ones. The
package ships only `.d.ts` files and runs no install script, so a compromise
lies to the type checker rather than executing code. Wrong types are the larger
risk here.

**`@parcel/watcher` runs an install script.** It is the only install script in
all nine dependency trees. It arrives under `@tailwindcss/cli` and compiles a
native binary. It is long-lived and widely used, so this is accepted, not
ignored. If the CSS build ever moves off the Tailwind CLI, this leaves with it.

**Single maintainers are the standing risk.** `elysia`, `daisyui`, and `oxlint`
each publish through one account. A stolen token on any of them lands in our
tree at the next unpinned install. Exact pins are the reason that does not
happen automatically.

## Later milestones

These are not audited yet. Audit each one before it lands.

`playwright` and a JOSE library for OIDC token checks.

`dompurify`, `jsdom`, and `@mozilla/readability` were audited on 2026-09-01 and
are pinned above. `linkedom` was audited at the same time and rejected. See
`plan/audits/03-dom-stack.md`; the short version is in "Rejected" below.

## single-file-cli flags, confirmed from its source

The README once named these wrongly. These spellings come from `options.js` in
version 2.1.3.

- `--blocked-url-pattern` takes regular expressions, not globs. The `url` part
  is lowercase.
- `--browser-executable-path` points at the Chromium we supply. The package
  downloads no browser of its own.
- The output path is the second positional argument, not a flag.

## What 2.1.3 costs us, and how the code covers it

Version 2.6.4 fixes four things that touch our exact use. Every fix landed
inside the same one-week release burst, so no version old enough to install has
them. We stay on 2.1.3 until 2026-09-14 and cover the two that matter in our
own code.

| Gap in 2.1.3 | Fixed in | Our cover |
| ------------ | -------- | --------- |
| The process exits 0 even when a capture fails | 2.3.0 | `capture` never trusts the exit code alone. It checks the output file exists and holds more than a trivial number of bytes. |
| `--blocked-url-pattern` blocks after the response, so the host is still contacted | 2.6.0 | None. Blocked content still stays out of the capture; the request leaks. Accepted until the bump. |
| Cross-origin iframes are saved empty | 2.3.1 | None. Accepted until the bump. |
| A circular `@import` hangs until the timeout | 2.6.2 | The adapter's own kill timer bounds it. |

The exit-code check is worth keeping after the bump. A tool that reports
success while writing nothing is a failure mode worth catching in our code
rather than trusting a version number to prevent.

See `plan/audits/01b-single-file-cli-versions.md` for the full comparison.
