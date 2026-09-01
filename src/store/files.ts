import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { AppError } from "../contracts/errors";

export const ITEM_FILES = [
  "original.html",
  "sanitized.html",
  "transcript.txt",
  "map.json",
] as const;

export type ItemFile = (typeof ITEM_FILES)[number];

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let tempCounter = 0;

function checkId(id: string, label: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw new AppError(
      "STORE_INVALID_PATH",
      `${label} is not a lowercase UUID`,
      { [label]: id },
    );
  }
}

export function itemDir(
  itemsRoot: string,
  userId: string,
  itemId: string,
): string {
  // The UUID check is the only defence against `..` escaping the root.
  checkId(userId, "user_id");
  checkId(itemId, "item_id");
  return join(itemsRoot, userId, itemId);
}

export async function writeItemFile(
  itemsRoot: string,
  userId: string,
  itemId: string,
  file: ItemFile,
  data: string | Uint8Array,
): Promise<void> {
  const dir = itemDir(itemsRoot, userId, itemId);
  await mkdir(dir, { recursive: true });
  const target = join(dir, file);
  // A rename inside one directory is atomic; a direct write is not. The
  // counter, not the clock and not randomness, keeps the name unique per
  // process, and the pid separates processes.
  const temp = join(dir, `.tmp-${process.pid}-${(tempCounter += 1)}`);
  try {
    await writeFile(temp, data);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    const reason = error instanceof Error ? error.message : String(error);
    throw new AppError("STORE_WRITE_FAILED", `cannot write ${target}`, {
      path: target,
      reason,
    });
  }
}

export async function readItemFile(
  itemsRoot: string,
  userId: string,
  itemId: string,
  file: ItemFile,
): Promise<string> {
  const path = join(itemDir(itemsRoot, userId, itemId), file);
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AppError("STORE_NOT_FOUND", `no such file: ${path}`, {
        path,
      });
    }
    throw error;
  }
}

export async function itemFilesPresent(
  itemsRoot: string,
  userId: string,
  itemId: string,
): Promise<ItemFile[]> {
  const dir = itemDir(itemsRoot, userId, itemId);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const present = new Set(entries);
  return ITEM_FILES.filter((file) => present.has(file));
}

export async function deleteItemDir(
  itemsRoot: string,
  userId: string,
  itemId: string,
): Promise<void> {
  const dir = itemDir(itemsRoot, userId, itemId);
  await rm(dir, { recursive: true, force: true });
}

export async function sweepOrphans(
  itemsRoot: string,
  known: Set<string>,
  olderThan: Date,
): Promise<string[]> {
  let userDirs: string[];
  try {
    userDirs = await readdir(itemsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const deleted: string[] = [];
  for (const user of userDirs) {
    const userPath = join(itemsRoot, user);
    if (!(await stat(userPath)).isDirectory()) continue;
    for (const item of await readdir(userPath)) {
      const itemPath = join(userPath, item);
      if (known.has(`${user}/${item}`)) continue;
      if ((await stat(itemPath)).mtime >= olderThan) continue;
      await rm(itemPath, { recursive: true, force: true });
      deleted.push(itemPath);
    }
  }
  return deleted.toSorted();
}
