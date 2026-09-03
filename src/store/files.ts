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
import type { ItemId, UserId } from "../contracts/ids";

export type ItemFile =
  | "original.html"
  | "sanitized.html"
  | "transcript.txt"
  | "map.json";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let tempCounter = 0;

function checkId(value: string, label: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new AppError(
      "STORE_INVALID_PATH",
      `${label} is not a lowercase UUID`,
      { [label]: value },
    );
  }
}

export function itemDir(
  itemsRoot: string,
  userId: UserId,
  itemId: ItemId,
): string {
  // Validate both path segments to prevent directory traversal.
  checkId(userId, "user_id");
  checkId(itemId, "item_id");
  return join(itemsRoot, userId, itemId);
}

// Creates an item directory using the store's canonical layout.
export async function ensureItemDir(
  itemsRoot: string,
  userId: UserId,
  itemId: ItemId,
): Promise<string> {
  const dir = itemDir(itemsRoot, userId, itemId);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function writeItemFile(
  itemsRoot: string,
  userId: UserId,
  itemId: ItemId,
  file: ItemFile,
  data: string | Uint8Array,
): Promise<void> {
  const dir = itemDir(itemsRoot, userId, itemId);
  await mkdir(dir, { recursive: true });
  const target = join(dir, file);
  // Write and rename within one directory for an atomic replacement. The
  // process ID and counter make temporary names unique without time or random
  // values.
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
  userId: UserId,
  itemId: ItemId,
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
