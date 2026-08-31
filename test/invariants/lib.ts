import { readdir, readFile } from "node:fs/promises";
import { dirname, join, normalize, relative } from "node:path";

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
  "Math.random(",
  "crypto.randomUUID(",
  "new Date(",
  "Bun.randomUUIDv7(",
  "Bun.nanoseconds(",
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
