import { join, relative } from "node:path";

const repoRoot = join(import.meta.dir, "..");

export async function computeSeals(
  dir: string,
): Promise<Record<string, string>> {
  const glob = new Bun.Glob("**/*.test.{ts,tsx}");
  const seals: Record<string, string> = {};
  for await (const path of glob.scan({ cwd: dir, onlyFiles: true })) {
    const absolute = join(dir, path);
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(await Bun.file(absolute).arrayBuffer());
    seals[relative(repoRoot, absolute).replaceAll("\\", "/")] =
      hasher.digest("hex");
  }
  return sortKeys(seals);
}

export function checkSeals(
  recorded: Record<string, string>,
  actual: Record<string, string>,
): { ok: boolean; changed: string[]; missing: string[]; extra: string[] } {
  const changed: string[] = [];
  const missing: string[] = [];
  const extra: string[] = [];
  for (const [path, hash] of Object.entries(recorded)) {
    const current = actual[path];
    if (current === undefined) missing.push(path);
    else if (current !== hash) changed.push(path);
  }
  for (const path of Object.keys(actual)) {
    if (!(path in recorded)) extra.push(path);
  }
  return {
    ok: changed.length === 0 && missing.length === 0 && extra.length === 0,
    changed: changed.toSorted(),
    missing: missing.toSorted(),
    extra: extra.toSorted(),
  };
}

function sortKeys(record: Record<string, string>): Record<string, string> {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(record).toSorted()) sorted[key] = record[key]!;
  return sorted;
}

if (import.meta.main) {
  const dir = join(import.meta.dir, "..", "test", "acceptance");
  const seals = await computeSeals(dir);
  await Bun.write(
    join(dir, "seals.json"),
    `${JSON.stringify(seals, null, 2)}\n`,
  );
  console.log(`sealed ${Object.keys(seals).length} file(s)`);
}
