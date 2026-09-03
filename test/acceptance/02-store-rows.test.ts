import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { AppError } from "../../src/contracts/errors";
import { asItemId, asTokenId, asUserId } from "../../src/contracts/ids";
import { parseSettings } from "../../src/contracts/settings";
import type { ApiToken, Item, User } from "../../src/contracts/item";
import { migrate } from "../../src/store/db";
import { getUserSettings, updateUserSettings } from "../../src/store/settings";
import { getItem, insertItem, updateItem } from "../../src/store/items";
import {
  deleteApiToken,
  getApiTokenByHash,
  insertApiToken,
  listApiTokens,
} from "../../src/store/users";
import { insertUser } from "../../src/store/users";

const NOW = "2026-02-01T00:00:00.000Z";
const ALICE = asUserId("11111111-1111-4111-8111-111111111111");
const BOB = asUserId("22222222-2222-4222-8222-222222222222");
const ITEM = asItemId("aaaaaaaa-0000-4000-8000-000000000001");
const OTHER_ITEM = asItemId("aaaaaaaa-0000-4000-8000-000000000002");
const TOKEN = asTokenId("dddddddd-0000-4000-8000-000000000001");

function database(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, new Date(NOW));
  insertUser(db, user(ALICE, "alice"));
  insertUser(db, user(BOB, "bob"));
  return db;
}

function user(id: typeof ALICE, subject: string): User {
  return { id, subject, email: `${subject}@example.com`, created_at: NOW };
}

function item(id: typeof ITEM, userId: typeof ALICE, title = "A saved item"): Item {
  return {
    id,
    user_id: userId,
    url: `https://example.com/${id}`,
    title,
    author: null,
    created_at: NOW,
    ingested_at: null,
  };
}

function token(): ApiToken {
  return {
    id: TOKEN,
    user_id: ALICE,
    name: "phone",
    token_hash: "hash",
    created_at: NOW,
    last_used_at: null,
  };
}

describe("tenant-scoped rows", () => {
  test("users see only their own items and tokens", () => {
    const db = database();
    insertItem(db, item(ITEM, ALICE));
    insertItem(db, item(OTHER_ITEM, BOB));
    insertApiToken(db, token());

    expect(getItem(db, ALICE, ITEM)).not.toBeNull();
    expect(getItem(db, BOB, ITEM)).toBeNull();
    expect(listApiTokens(db, ALICE)).toHaveLength(1);
    expect(listApiTokens(db, BOB)).toEqual([]);
    db.close();
  });

  test("cross-tenant updates and deletes do not change the owner's rows", () => {
    const db = database();
    insertItem(db, item(ITEM, ALICE));
    insertApiToken(db, token());

    expect(() => updateItem(db, BOB, ITEM, { title: "stolen" })).toThrow(AppError);
    deleteApiToken(db, BOB, TOKEN);

    expect(getItem(db, ALICE, ITEM)!.title).toBe("A saved item");
    expect(getApiTokenByHash(db, "hash")).not.toBeNull();
    db.close();
  });

  test("stores settings per tenant and rejects invalid values", () => {
    const db = database();
    const alice = getUserSettings(db, ALICE);
    updateUserSettings(db, { ...alice, theme: "dark", text_size: 22 });
    expect(getUserSettings(db, ALICE)).toMatchObject({ theme: "dark", text_size: 22 });
    expect(getUserSettings(db, BOB).theme).toBe("auto");
    db.run("DELETE FROM user_settings WHERE user_id = ?", [BOB]);
    expect(() => getUserSettings(db, BOB)).toThrow(
      expect.objectContaining({ code: "STORE_NOT_FOUND" }),
    );
    expect(() => parseSettings(ALICE, { theme: "blue", font: "newsreader", text_size: "18", line_spacing: "170", paragraph_spacing: "90", text_width: "68" })).toThrow(AppError);
    db.close();
  });

  test("updates only named item fields", () => {
    const db = database();
    insertItem(db, item(ITEM, ALICE));
    const updated = updateItem(db, ALICE, ITEM, { title: "Renamed" });
    expect(updated.title).toBe("Renamed");
    expect(updated.url).toBe(`https://example.com/${ITEM}`);
    db.close();
  });
});
