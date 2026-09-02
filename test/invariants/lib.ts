import { JSDOM } from "jsdom";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, normalize, relative } from "node:path";

import { contentRanges } from "../../src/contracts/transcript";
import type { TranscriptMap } from "../../src/contracts/transcript";
import type { TableInfo } from "../../src/store/db";

export type ImportEdge = { from: string; to: string; line: number };

export type Violation = {
  file: string;
  line: number;
  rule: string;
  detail: string;
};

export type Layer =
  | "contracts"
  | "core"
  | "store"
  | "services"
  | "web"
  | "cli"
  | "scripts"
  | "test";

const LAYER_DIRS = [
  "contracts",
  "core",
  "store",
  "services",
  "web",
  "cli",
] as const;

const MAY_IMPORT: Record<Layer, Layer[]> = {
  contracts: [],
  core: ["contracts"],
  store: ["contracts", "core"],
  services: ["contracts", "core", "store"],
  web: ["contracts", "core", "store", "services"],
  cli: ["contracts", "core", "store", "services"],
  scripts: ["contracts", "core", "store", "services", "web", "cli", "scripts", "test"],
  test: ["contracts", "core", "store", "services", "web", "cli", "scripts", "test"],
};

const IMPURE_MODULES = ["node:fs", "node:path", "bun:sqlite"];
const IMPURE_LAYERS: Layer[] = ["store", "services", "web", "cli"];

const THROW_PATTERN = /throw\s+new\s+Error\s*\(/g;
const NONDETERMINISTIC_CALLS = [
  "Date.now(",
  "Date.parse(",
  "Date.UTC(",
  "Math.random(",
  "crypto.randomUUID(",
  "new Date(",
  "Bun.randomUUIDv7(",
  "Bun.nanoseconds(",
  "crypto.getRandomValues(",
  "crypto.subtle",
  "crypto.randomBytes(",
];
const NONDETERMINISTIC_ALLOWED = [
  "src/contracts/clock.ts",
  "src/contracts/ids.ts",
];

export function layerOf(path: string): Layer | null {
  const p = normalize(path).replaceAll("\\", "/");
  for (const dir of LAYER_DIRS) {
    if (p.includes(`src/${dir}/`)) return dir;
  }
  if (p.includes("scripts/")) return "scripts";
  if (p.includes("test/")) return "test";
  return null;
}

// scanImports strips type-only imports, so union its result with a pass
// over import/export statements that mention the `type` keyword. The regex
// is anchored to statement starts and the [^;] guard keeps a from-less
// statement from swallowing a later one.
const TYPE_ONLY_IMPORT =
  /^\s*(?:import|export)\s+(?:type\s+)?[^;]*?\btype\b[^;]*?\s+from\s+["']([^"']+)["']/gm;

export function collectImports(path: string, source: string): ImportEdge[] {
  const transpiler = new Bun.Transpiler({ loader: "tsx" });
  const lines = source.split("\n");
  const edges: ImportEdge[] = [];
  const seen = new Set<string>();
  const add = (to: string) => {
    if (seen.has(to)) return;
    seen.add(to);
    let line = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.includes(to)) {
        line = i + 1;
        break;
      }
    }
    edges.push({ from: path, to, line });
  };
  for (const found of transpiler.scanImports(source)) add(found.path);
  for (const match of source.matchAll(TYPE_ONLY_IMPORT)) add(match[1]!);
  return edges;
}

function resolveTarget(edge: ImportEdge): string {
  if (!edge.to.startsWith(".")) return edge.to;
  return normalize(join(dirname(edge.from), edge.to)).replaceAll("\\", "/");
}

export function checkLayers(edges: ImportEdge[]): Violation[] {
  const violations: Violation[] = [];
  for (const edge of edges) {
    const from = layerOf(edge.from);
    if (from === null) continue;
    const to = layerOf(resolveTarget(edge));
    if (to === null || to === from) continue;
    if (MAY_IMPORT[from]!.includes(to)) continue;
    violations.push({
      file: edge.from,
      line: edge.line,
      rule: "layers",
      detail: `${from} may not import ${to} (via "${edge.to}")`,
    });
  }
  return violations;
}

export function checkPurity(edges: ImportEdge[]): Violation[] {
  const violations: Violation[] = [];
  for (const edge of edges) {
    if (layerOf(edge.from) !== "core") continue;
    const impureModule = IMPURE_MODULES.some(
      (mod) => edge.to === mod || edge.to.startsWith(`${mod}/`),
    );
    const impureLayer = IMPURE_LAYERS.includes(
      layerOf(resolveTarget(edge)) as Layer,
    );
    if (impureModule || impureLayer) {
      violations.push({
        file: edge.from,
        line: edge.line,
        rule: "purity",
        detail: `core may not import "${edge.to}"`,
      });
    }
  }
  return violations;
}

export function checkErrorThrows(
  files: { path: string; source: string }[],
): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    for (const match of file.source.matchAll(THROW_PATTERN)) {
      const line = file.source.slice(0, match.index).split("\n").length;
      violations.push({
        file: file.path,
        line,
        rule: "error-codes",
        detail:
          "throw new Error(...) is banned; throw an AppError with a code",
      });
    }
  }
  return violations;
}

export function checkDeterminism(
  files: { path: string; source: string }[],
): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const path = file.path.replaceAll("\\", "/");
    if (NONDETERMINISTIC_ALLOWED.some((allowed) => path.endsWith(allowed))) {
      continue;
    }
    for (const call of NONDETERMINISTIC_CALLS) {
      let index = file.source.indexOf(call);
      while (index !== -1) {
        const line = file.source.slice(0, index).split("\n").length;
        violations.push({
          file: file.path,
          line,
          rule: "determinism",
          detail: `"${call}" may only appear in src/contracts/clock.ts or src/contracts/ids.ts`,
        });
        index = file.source.indexOf(call, index + 1);
      }
    }
  }
  return violations;
}

// An id-shaped parameter or field must carry its brand. A branded id is a
// string, so the compiler only catches mistakes in one direction; the naming
// convention is what keeps the other direction closed. A raw string is fine
// exactly where a value is validated into a brand: src/contracts/ids.ts, and
// any parameter named `value`.
const BRANDED_ID_PATTERN =
  /\b(id|userId|itemId|tokenId|annotationId|requestId|user_id|item_id|annotation_id)\??:\s*(string(?:\s*\|\s*null)?|null\s*\|\s*string)\b/g;
const BRANDED_IDS_EXEMPT = new Set(["src/contracts/ids.ts"]);

export function checkBrandedIds(
  files: { path: string; source: string }[],
): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const path = file.path.replaceAll("\\", "/");
    if (BRANDED_IDS_EXEMPT.has(path)) continue;
    for (const match of file.source.matchAll(BRANDED_ID_PATTERN)) {
      const line = file.source.slice(0, match.index).split("\n").length;
      violations.push({
        file: path,
        line,
        rule: "branded-ids",
        detail: `"${match[1]}" is typed "${match[2].replaceAll(/\s+/g, "")}"; use a branded id`,
      });
    }
  }
  return violations;
}

// Bun's I/O sits on globals and needs no import, so imports alone do not
// prove that src/core/ stays pure.
const IMPURE_GLOBAL_CALLS = [
  "Bun.file(",
  "Bun.write(",
  "Bun.spawn(",
  "Bun.$",
  "fetch(",
  "new Worker(",
];

export function checkPurityGlobals(
  files: { path: string; source: string }[],
): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    if (layerOf(file.path) !== "core") continue;
    for (const call of IMPURE_GLOBAL_CALLS) {
      let index = file.source.indexOf(call);
      while (index !== -1) {
        const before = index > 0 ? file.source[index - 1]! : "";
        // The boundary guard stops identifiers like "prefetch(" from
        // matching "fetch(".
        if (!/[A-Za-z0-9_$]/.test(before)) {
          const line = file.source.slice(0, index).split("\n").length;
          violations.push({
            file: file.path,
            line,
            rule: "purity",
            detail: `src/core/ may not touch "${call}"; Bun's I/O needs no import`,
          });
        }
        index = file.source.indexOf(call, index + 1);
      }
    }
  }
  return violations;
}

// A run's offset range must tile the transcript exactly: no gaps, no
// overlaps, no text outside the map.
export type OffsetsViolation = {
  rule: "offsets";
  detail: string;
};

export function checkOffsets(
  transcript: string,
  runs: ReadonlyArray<{ start: number; end: number }>,
): OffsetsViolation[] {
  const violations: OffsetsViolation[] = [];
  if (runs.length === 0) {
    if (transcript.length > 0) {
      violations.push({
        rule: "offsets",
        detail: "the map has no runs but the transcript is not empty",
      });
    }
    return violations;
  }

  let cursor = 0;
  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i]!;
    if (run.end <= run.start) {
      violations.push({
        rule: "offsets",
        detail: `run ${i} spans ${run.start}..${run.end}; end must exceed start`,
      });
      continue;
    }
    if (run.start !== cursor) {
      const kind = run.start < cursor ? "overlaps" : "leaves a gap before";
      violations.push({
        rule: "offsets",
        detail: `run ${i} starts at ${run.start} but the text up to ${cursor} is tiled; it ${kind} this run`,
      });
    }
    cursor = Math.max(cursor, run.end);
  }

  if (cursor !== transcript.length) {
    violations.push({
      rule: "offsets",
      detail: `runs end at ${cursor} but the transcript length is ${transcript.length}`,
    });
  }
  return violations;
}

// The module list from docs/architecture.md. A file under src/ that is not listed here
// (exactly or through one of the explicit prefixes) has no layer and
// therefore no rules, so its existence is itself a violation.
const ALLOWED_MODULES = [
  "src/contracts/ids.ts",
  "src/contracts/clock.ts",
  "src/contracts/errors.ts",
  "src/contracts/transcript.ts",
  "src/contracts/item.ts",
  "src/contracts/config.ts",
  "src/core/sanitize.ts",
  "src/core/walk.ts",
  "src/core/epub.ts",
  "src/core/project.ts",
  "src/core/anchor.ts",
  "src/core/search.ts",
  "src/store/db.ts",
  "src/store/config.ts",
  "src/store/items.ts",
  "src/store/annotations.ts",
  "src/store/users.ts",
  "src/store/queue.ts",
  "src/store/fts.ts",
  "src/store/files.ts",
  "src/services/acquire.ts",
  "src/services/ingest.ts",
  "src/services/library.ts",
  "src/services/annotate.ts",
  "src/services/export.ts",
  "src/services/auth.ts",
  "src/services/worker.ts",
  "src/web/server.ts",
  "src/cli/main.ts",
];

// Named prefixes, not a bare src/, so a milestone can add a view or route
// without editing this array.
const ALLOWED_PREFIXES = ["src/web/routes/", "src/web/views/", "src/web/client/"];

export function checkModuleList(
  files: { path: string }[],
): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const path = file.path.replaceAll("\\", "/");
    if (!path.startsWith("src/")) continue;
    if (layerOf(path) === null) {
      violations.push({
        file: path,
        line: 0,
        rule: "module-list",
        detail: `"${path}" does not map to a layer`,
      });
      continue;
    }
    const listed =
      ALLOWED_MODULES.includes(path) ||
      ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix));
    if (!listed) {
      violations.push({
        file: path,
        line: 0,
        rule: "module-list",
        detail: `"${path}" is not in the module list (docs/architecture.md)`,
      });
    }
  }
  return violations;
}

export async function listSources(
  root: string,
  dir: string,
): Promise<{ path: string; source: string }[]> {
  const files: { path: string; source: string }[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        files.push({
          path: relative(root, absolute).replaceAll("\\", "/"),
          source: await readFile(absolute, "utf8"),
        });
      }
    }
  }
  await walk(dir);
  return files.toSorted((a, b) => a.path.localeCompare(b.path));
}

export type SchemaViolation = {
  table: string;
  rule: string;
  detail: string;
};

// The exact column set of every non-exempt table, taken from the version 1
// schema in src/store/db.ts. Each value is sorted. Adding or dropping a
// column is a schema change and must land here in the same change.
export const EXPECTED_COLUMNS: Record<string, readonly string[]> = {
  migrations: ["applied_at", "version"],
  users: ["created_at", "email", "id", "subject"],
  api_tokens: ["created_at", "id", "last_used_at", "name", "token_hash", "user_id"],
  items: ["author", "created_at", "id", "ingested_at", "kind", "title", "url", "user_id"],
  annotations: [
    "created_at",
    "end_offset",
    "id",
    "item_id",
    "note",
    "quote",
    "start_offset",
    "updated_at",
    "user_id",
  ],
  fetch_requests: [
    "attempts",
    "created_at",
    "error_code",
    "id",
    "item_id",
    "lease_expires_at",
    "source_path",
    "state",
    "url",
    "user_id",
  ],
  blocks_fts: [
    "block_index",
    "end_offset",
    "is_content",
    "item_id",
    "start_offset",
    "text",
    "user_id",
  ],
};

const SQLITE_PREFIX = "sqlite_";
const FTS_SHADOW_SUFFIXES = ["_data", "_idx", "_content", "_docsize", "_config"];
const TENANCY_EXEMPT = new Set(["migrations", "users"]);

// An FTS5 virtual table's shadow tables are found from its `sql`, and the
// exemption is the exact five names, not a prefix, so a later plain table
// such as items_fts_notes still has to carry user_id.
function ftsShadowNames(tables: TableInfo[]): Set<string> {
  const shadows = new Set<string>();
  for (const table of tables) {
    if (!/using\s+fts5/i.test(table.sql)) continue;
    for (const suffix of FTS_SHADOW_SUFFIXES) shadows.add(`${table.name}${suffix}`);
  }
  return shadows;
}

export function checkTenancy(tables: TableInfo[]): SchemaViolation[] {
  const exempt = ftsShadowNames(tables);
  const violations: SchemaViolation[] = [];
  for (const table of tables) {
    if (
      table.name.startsWith(SQLITE_PREFIX) ||
      TENANCY_EXEMPT.has(table.name) ||
      exempt.has(table.name)
    ) {
      continue;
    }
    if (!table.columns.includes("user_id")) {
      violations.push({
        table: table.name,
        rule: "tenancy",
        detail: `"${table.name}" has no user_id column`,
      });
    }
  }
  return violations;
}

// A name break is a weak backstop for a table a later milestone adds. The
// allowlist is the real rule, because a DOM path can hide behind any name.
const POSITION_NAME_PATTERNS = [/_path$/, /xpath/, /selector/, /_dom/, /dom_/, /node/, /doc_index/];
// The one name the allowlist admits: a filesystem path of a user-imported
// file, never a position inside a document.
const POSITION_NAME_ALLOWED = new Set(["source_path"]);

export function checkNoPositionsInDb(tables: TableInfo[]): SchemaViolation[] {
  const exempt = ftsShadowNames(tables);
  const violations: SchemaViolation[] = [];
  for (const table of tables) {
    if (table.name.startsWith(SQLITE_PREFIX) || exempt.has(table.name)) continue;
    const expected = EXPECTED_COLUMNS[table.name];
    if (expected === undefined) {
      // A table nobody pinned has no column rule at all, so the allowlist
      // would quietly stop meaning anything. The name pass below still runs,
      // so an unpinned table with a position-shaped column fails twice.
      violations.push({
        table: table.name,
        rule: "no-positions-in-db",
        detail: `"${table.name}" is not pinned in EXPECTED_COLUMNS`,
      });
    } else {
      const actual = [...table.columns].toSorted();
      const extra = actual.filter((column) => !expected.includes(column));
      const missing = expected.filter((column) => !actual.includes(column));
      if (extra.length > 0 || missing.length > 0) {
        const parts: string[] = [];
        if (extra.length > 0) {
          parts.push(`has unexpected column(s) ${extra.join(", ")}`);
        }
        if (missing.length > 0) {
          parts.push(`is missing column(s) ${missing.join(", ")}`);
        }
        violations.push({
          table: table.name,
          rule: "no-positions-in-db",
          detail: `"${table.name}" ${parts.join(" and ")}`,
        });
      }
    }
    for (const column of table.columns) {
      if (POSITION_NAME_ALLOWED.has(column)) continue;
      if (POSITION_NAME_PATTERNS.some((pattern) => pattern.test(column))) {
        violations.push({
          table: table.name,
          rule: "no-positions-in-db",
          detail: `"${table.name}.${column}" looks like a position inside a document`,
        });
      }
    }
  }
  return violations;
}


// The public routes. This list is the decision record. It names five paths
// where plan/briefs/04-auth-spec.md names four, because "/" was added after
// that document was written and only this list is kept current:
// - "/" — the landing page is public; the acceptance suite requires GET /
//   to answer 200 with no credential.
// - "/health" — the container health check has no credential.
// - "/app.css" — a static stylesheet.
// - "/login" — starts a login, so a signed-out reader must reach it.
// - "/login/callback" — the issuer's redirect target arrives signed out.
export const UNGUARDED_ROUTES = new Set([
  "/",
  "/health",
  "/app.css",
  "/login",
  "/login/callback",
  "/logout",
  "/reader.js",
]);

// A route call's first argument, taken up to the first comma, parenthesis,
// or whitespace. It is either a quoted literal or a token that is not a
// literal at all, such as a variable; checkRouteGuard tells the two apart.
const ROUTE_PATTERN = /\.(get|post|put|patch|delete|all)\(\s*([^,()\s]+)/g;

const LITERAL_PATH_PATTERNS = [/^"([^"]*)"$/, /^'([^']*)'$/, /^`([^`]*)`$/];

function literalPathOf(token: string): string | null {
  for (const pattern of LITERAL_PATH_PATTERNS) {
    const match = token.match(pattern);
    if (match) return match[1]!;
  }
  return null;
}

// Limit, not solved: the handler slice for the last route in a file runs to
// the end of the file, so an authenticate( in unrelated code below that route
// would vouch for it. Closing that hole needs parsing, not text.
export function checkRouteGuard(
  files: { path: string; source: string }[],
): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const path = file.path.replaceAll("\\", "/");
    if (!path.includes("src/web/")) continue;
    for (const match of file.source.matchAll(ROUTE_PATTERN)) {
      const line = file.source.slice(0, match.index).split("\n").length;
      const route = literalPathOf(match[2]!);
      if (route === null) {
        violations.push({
          file: file.path,
          line,
          rule: "route-guard",
          detail: `route path "${match[2]}" is not a string literal the checker can read`,
        });
        continue;
      }
      // `.get("q")` on a URLSearchParams is not a route. A route path is
      // always rooted, so a literal that does not start with "/" is some
      // other method that happens to share the name.
      if (!route.startsWith("/")) continue;
      if (UNGUARDED_ROUTES.has(route)) continue;
      const body = file.source.slice(match.index);
      const handler = body.slice(0, nextRouteIndex(body));
      if (handler.includes("authenticate(")) continue;
      violations.push({
        file: file.path,
        line,
        rule: "route-guard",
        detail: `route "${route}" neither calls authenticate nor is listed as unguarded`,
      });
    }
  }
  return violations;
}

function nextRouteIndex(body: string): number {
  ROUTE_PATTERN.lastIndex = 0;
  const matches = [...body.matchAll(ROUTE_PATTERN)];
  return matches.length > 1 ? matches[1]!.index! : body.length;
}

// Invariant 5: the round trip. Project a range, read the text inside the
// highlight elements, and it must equal the transcript slice that range
// stands for. A range crossing a non-content run reads back as the content
// parts it covers, in order, because the reader view renders content only.
export type RoundTripViolation = {
  fixture: string;
  start: number;
  end: number;
  expected: string;
  got: string;
};

export function checkRoundTrip(
  fixture: string,
  transcript: string,
  map: TranscriptMap,
  ranges: Array<{ start: number; end: number }>,
  render: (range: { start: number; end: number }) => string,
): RoundTripViolation[] {
  const violations: RoundTripViolation[] = [];
  for (const range of ranges) {
    if (range.end <= range.start) continue;

    const document = new JSDOM(`<body>${render(range)}</body>`).window.document;
    const got = [...document.querySelectorAll("mark[data-cp-annotation]")]
      .map((mark) => mark.textContent ?? "")
      .join("");
    const expected = contentRanges(map, range.start, range.end)
      .map((part) => transcript.slice(part.start, part.end))
      .join("");

    if (got !== expected) {
      violations.push({ fixture, start: range.start, end: range.end, expected, got });
    }
  }
  return violations;
}

// Invariant 8: the capture route serves someone else's page, so it runs with
// no script at all. The checker reads the route's own handler, not the whole
// file, so a header set on a different route cannot vouch for this one.
export const CAPTURE_ROUTE = "/items/:id/capture";

export function checkCaptureCsp(
  files: { path: string; source: string }[],
): Violation[] {
  const violations: Violation[] = [];
  let found = 0;

  for (const file of files) {
    const path = file.path.replaceAll("\\", "/");
    if (!path.includes("src/web/")) continue;

    for (const match of file.source.matchAll(ROUTE_PATTERN)) {
      if (literalPathOf(match[2]!) !== CAPTURE_ROUTE) continue;
      found += 1;

      const line = file.source.slice(0, match.index).split("\n").length;
      const body = file.source.slice(match.index);
      const handler = body.slice(0, nextRouteIndex(body));
      if (!handler.includes("script-src 'none'")) {
        violations.push({
          file: file.path,
          line,
          rule: "capture-csp",
          detail: `the ${CAPTURE_ROUTE} handler does not send script-src 'none'`,
        });
      }
    }
  }

  if (found !== 1) {
    violations.push({
      file: "src/web/",
      line: 0,
      rule: "capture-csp",
      detail: `expected exactly one ${CAPTURE_ROUTE} route, found ${found}`,
    });
  }
  return violations;
}
