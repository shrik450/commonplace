# Dependencies

Every package here passed an audit before it landed. This file records what we
pin, why, and when to look again.

## Rules

**Pin exact versions.** No `^`, no `~`. A range is an unreviewed future install.
`bunfig.toml` sets `exact = true`, so `bun add` cannot write a range by accident.

**Nothing younger than 14 days.** `bunfig.toml` sets
`install.minimumReleaseAge = 1209600`. Bun filters out any version published
more recently, at resolve time, for direct and transitive packages alike. A
stolen publish token shows up as a fresh release, so age is a cheap filter that
works even when nobody is watching.

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
| `@types/bun` | 1.4.0 | matches the Bun 1.4.0 runtime; see the note below | with each Bun upgrade |

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

`dompurify`, `jsdom`, `@mozilla/readability`, `@msgpack/msgpack`, `playwright`,
`single-file-cli`, and a JOSE library for OIDC token checks.
