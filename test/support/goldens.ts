import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const SYNTHETIC_ROOT = join(
  import.meta.dir,
  "..",
  "fixtures",
  "synthetic",
);

export function goldenPath(
  fixture: string,
  name: string,
  root: string = SYNTHETIC_ROOT,
): string {
  return join(root, fixture, name);
}

export async function readGolden(
  fixture: string,
  name: string,
  root?: string,
): Promise<string | null> {
  try {
    return await readFile(goldenPath(fixture, name, root), "utf8");
  } catch {
    return null;
  }
}

export async function writeGolden(
  fixture: string,
  name: string,
  text: string,
  root?: string,
): Promise<void> {
  const path = goldenPath(fixture, name, root);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

export async function assertGolden(
  fixture: string,
  name: string,
  actual: string,
  root?: string,
): Promise<void> {
  const path = goldenPath(fixture, name, root);

  if (process.env.UPDATE_GOLDENS === "1") {
    await writeGolden(fixture, name, actual, root);
    return;
  }

  const expected = await readGolden(fixture, name, root);
  if (expected === null) {
    throw new Error(
      `golden does not exist: ${path}\n` +
        "set UPDATE_GOLDENS=1 to write it, or run the writer first",
    );
  }

  if (expected === actual) return;

  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  for (let i = 0; i < Math.max(expectedLines.length, actualLines.length); i += 1) {
    const expectedLine = expectedLines[i];
    const actualLine = actualLines[i];
    if (expectedLine !== actualLine) {
      throw new Error(
        `golden mismatch at ${path}\n` +
          `line ${i + 1}:\n` +
          `  golden: ${JSON.stringify(expectedLine)}\n` +
          `  actual: ${JSON.stringify(actualLine)}`,
      );
    }
  }

  throw new Error(`golden mismatch at ${path}: no differing line found`);
}
