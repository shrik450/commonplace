# Dependencies

This file records each approved package version, its selection criteria, and
its next review point.

## Rules

**Pin exact versions.** Don't use `^` or `~`. A version range can install code
that the project hasn't reviewed. `bunfig.toml` sets `exact = true`, so
`bun add` writes exact versions.

**Require a 14-day release age.** `bunfig.toml` sets
`install.minimumReleaseAge = 1209600`. When Bun resolves a range, it excludes
direct and transitive package versions published within the last 14 days. This
delay reduces exposure to a compromised package release.

**The release-age rule applies only when Bun resolves a range.** A test on
2026-09-01 showed that `bun add dompurify@^3.4.0` selected 3.4.13 and excluded
the 12-day-old 3.4.14. However, `bun add dompurify@3.4.14` installed the exact
version. Run `bun add <package>` without a version to apply the age rule, then
let `exact = true` record the resolved version. Document the reason for any
explicit override.

`minimumReleaseAgeExcludes` exempts `@types/bun` because it must match the Bun
runtime version. The package contains only `.d.ts` files and has no install
script.

**Audit before the first install.** For each new package, review its publish
history, maintainer count, install scripts, and transitive dependency count.

## Current set

| Package | Pinned | Why this version | Re-check |
| ------- | ------ | ---------------- | -------- |
| `elysia` | 1.4.29 | 1.4.30 was 5 days old at audit; 1.4.29 has aged | when 1.4.30 passes 14 days |
| `tailwindcss` | 4.3.3 | 46 days old, three maintainers, zero deps | on next major |
| `@tailwindcss/cli` | 4.3.3 | same release train as `tailwindcss` | on next major |
| `daisyui` | 5.7.17 | 5.7.18 to 5.7.22 shipped in one week; that burst has not settled | when the cadence returns to normal |
| `oxlint` | 1.79.0 | 1.80.0 was 7 days old at audit | when 1.80.0 passes 14 days |
| `@oxlint/plugins` | 1.79.0 | Must match the Oxlint version; zero dependencies and no install script | with Oxlint |
| `typescript` | 7.0.2 | 54 days old, seven maintainers under Microsoft | on next minor |
| `single-file-cli` | 2.1.3 | 2.6.4 and ten more shipped in one week; 2.1.3 predates the burst | on 2026-09-14, when 2.6.4 ages out |
| `@types/bun` | 1.4.0 | matches the Bun 1.4.0 runtime; see the note below | with each Bun upgrade |
| `jsdom` | 30.0.1 | 33 days old, six maintainers, and the only DOM the other two work against | on next major |
| `dompurify` | 3.4.13 | 28 days old; 3.4.14 was 12 days old at audit | when 3.4.14 passes 14 days |
| `@mozilla/readability` | 0.6.0 | zero dependencies, three maintainers, Mozilla's repository | on next release |
| `@types/jsdom` | 30.0.0 | types only, no scripts, matches jsdom 30 | with each jsdom bump |

## Rejected

- `@elysiajs/html` — Adds 17 packages, including `yargs` and `chalk`, for
  behavior that Bun already provides. Bun compiles TSX itself, and an
  Elysia handler can return a `Response` holding a string.
- `@kitajs/html` — Escapes children **only** when the caller passes a `safe`
  attribute. Read
  `index.js` line 498 in version 4.2.13:
  `contentsToString(children, hasAttrs && attrs.safe)`. Escaping is opt-in, so
  omitting one attribute could cause a cross-site scripting vulnerability.

  The runtime in `src/web/views/jsx-runtime.ts` escapes every interpolated value
  and uses `raw()` as its only explicit opt-out. It delegates escaping to
  `Bun.escapeHTML`, the same native function that `@kitajs/html` uses with Bun.
  The local runtime changes the default behavior without implementing a new
  escaping algorithm.

- `linkedom` — DOMPurify doesn't support its window implementation. Although
  linkedom adds 16 packages instead of jsdom's 37 and doesn't read the file
  system during import, DOMPurify returns `isSupported: undefined` and leaves
  the input unchanged. It doesn't report an error, so unsupported sanitization
  could appear successful.

  Two parser differences also prevent its use. linkedom uses `htmlparser2`,
  which does not implement HTML tree construction. It does not insert the
  implied `tbody` inside a `table`, and it does not drop the newline after a
  `<pre>` start tag. Both make the walker's tree disagree with the browser's,
  and `node_path` addresses the browser's tree.

- `parse5` with a local sanitizer — Rejected. Its tree is correct
  and its dependency count is the lowest of the set, but Readability needs a
  DOM, so the project still needs a DOM library. A local HTML sanitizer would
  also need to handle the mutation-XSS bypass classes that DOMPurify tracks. `parse5` still
  arrives in the tree, inside `jsdom`.

- A JOSE library — The current authorization code flow doesn't require an ID
  token signature check. The token arrives in the body of a direct HTTPS request the
  server makes to the token endpoint. `discover` pins that endpoint's origin
  to the configured `issuer_url` and requires the `https:` scheme. OpenID
  Connect Core 3.1.3.7 item 6 says TLS server validation may stand in for the
  signature check in that case. Therefore, this flow doesn't fetch a JSON Web
  Key Set (JWKS), verify a JSON Web Token (JWT), or require a JOSE library.

  That argument holds only for the authorization code flow. An ID token that
  arrives from a redirect or a fragment has no TLS guarantee and would need a
  signature check and a JOSE library.

## Package risks

**`@types/bun` 1.4.0 is exempt from the release-age rule.** Version 1.3.14
doesn't describe the Bun 1.4.0 runtime and could produce incorrect type-check
results. Version 1.4.0 contains only `.d.ts` files and has no install script.

**`@parcel/watcher` runs an install script.** It is the only install script in
the dependency trees. `@tailwindcss/cli` uses it to compile a native binary.
Remove it if the CSS build stops using the Tailwind CLI.

**Three packages publish through one maintainer account.** A compromised
account for `elysia`, `daisyui`, or `oxlint` could publish a malicious release.
Exact version pins prevent an automatic upgrade to that release.

`@oxlint/plugins` has one maintainer, no dependencies, and no install script.
Its exact version must move with `oxlint` because the vendored plugin imports its
runtime types and compatibility helpers.

## Later milestones

Audit `playwright` before adding it.

`dompurify`, `jsdom`, and `@mozilla/readability` were audited on 2026-09-01 and
are pinned above. `linkedom` was audited at the same time and rejected. See
the Rejected section above.

## single-file-cli flags, confirmed from its source

These option names come from `options.js` in version 2.1.3.

- `--blocked-url-pattern` takes regular expressions, not globs. The `url` part
  is lowercase.
- `--browser-executable-path` points at the Chromium we supply. The package
  downloads no browser of its own.
- The output path is the second positional argument, not a flag.

## Known limitations in version 2.1.3

Version 2.6.4 fixes four relevant issues. Those fixes arrived during the same
one-week release period, so no version that meets the 14-day rule contains
them. Version 2.1.3 remains pinned until the next review on 2026-09-14. Local
code mitigates two issues.

| Gap in 2.1.3 | Fixed in | Our cover |
| ------------ | -------- | --------- |
| The process exits 0 even when a capture fails | 2.3.0 | `capture` never trusts the exit code alone. It checks the output file exists and holds more than a trivial number of bytes. |
| `--blocked-url-pattern` blocks after the response, so the host is still contacted | 2.6.0 | None. Blocked content still stays out of the capture; the request leaks. Accepted until the bump. |
| Cross-origin iframes are saved empty | 2.3.1 | None. Accepted until the bump. |
| A circular `@import` hangs until the timeout | 2.6.2 | The adapter's own kill timer bounds it. |

Keep the output-file check after upgrading. It verifies the capture result
independently of the process exit code.
