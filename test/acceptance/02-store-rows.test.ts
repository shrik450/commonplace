import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { AppError } from "../../src/contracts/errors";
import { asAnnotationId, asItemId, asTokenId, asUserId } from "../../src/contracts/ids";
import type { Annotation, ApiToken, Item, User } from "../../src/contracts/item";
import { migrate } from "../../src/store/db";
import {
  deleteAnnotation,
  getAnnotation,
  insertAnnotation,
  listAnnotations,
} from "../../src/store/annotations";
import {
  deleteItem,
  getItem,
  insertItem,
  updateItem,
} from "../../src/store/items";
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
const ANNOTATION = asAnnotationId("bbbbbbbb-0000-4000-8000-000000000001");
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

function annotation(id = ANNOTATION, itemId = ITEM, userId = ALICE): Annotation {
  return {
    id,
    user_id: userId,
    item_id: itemId,
    start_offset: 0,
    end_offset: 4,
    quote: "text",
    note: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

function errorCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof AppError ? error.code : "";
  }
  return "";
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
  test("users see only their own items, annotations, and tokens", () => {
    const db = database();
    insertItem(db, item(ITEM, ALICE));
    insertItem(db, item(OTHER_ITEM, BOB));
    insertAnnotation(db, annotation(ANNOTATION, ITEM, ALICE));
    insertApiToken(db, token());

    expect(getItem(db, ALICE, ITEM)).not.toBeNull();
    expect(getItem(db, BOB, ITEM)).toBeNull();
    expect(listAnnotations(db, BOB, ITEM)).toEqual([]);
    expect(getAnnotation(db, BOB, ANNOTATION)).toBeNull();
    expect(listApiTokens(db, ALICE)).toHaveLength(1);
    expect(listApiTokens(db, BOB)).toEqual([]);
    db.close();
  });

  test("cross-tenant writes and deletes do not change the owner's rows", () => {
    const db = database();
    insertItem(db, item(ITEM, ALICE));
    insertAnnotation(db, annotation());
    insertApiToken(db, token());

    expect(() => updateItem(db, BOB, ITEM, { title: "stolen" })).toThrow(AppError);
    deleteItem(db, BOB, ITEM);
    deleteAnnotation(db, BOB, ANNOTATION);
    deleteApiToken(db, BOB, TOKEN);

    expect(getItem(db, ALICE, ITEM)!.title).toBe("A saved item");
    expect(getAnnotation(db, ALICE, ANNOTATION)).not.toBeNull();
    expect(getApiTokenByHash(db, "hash")).not.toBeNull();
    db.close();
  });

  test("item deletion cascades annotations and updates named fields only", () => {
    const db = database();
    insertItem(db, item(ITEM, ALICE));
    insertAnnotation(db, annotation());
    const updated = updateItem(db, ALICE, ITEM, { title: "Renamed" });
    expect(updated.title).toBe("Renamed");
    expect(updated.url).toBe(`https://example.com/${ITEM}`);

    deleteItem(db, ALICE, ITEM);
    expect(getItem(db, ALICE, ITEM)).toBeNull();
    expect(getAnnotation(db, ALICE, ANNOTATION)).toBeNull();
    db.close();
  });
});

describe("store validation", () => {
  test("rejects annotations that end before they start", () => {
    const db = database();
    insertItem(db, item(ITEM, ALICE));
    expect(errorCode(() => insertAnnotation(db, { ...annotation(), start_offset: 4, end_offset: 2 }))).toBe(
      "STORE_CONSTRAINT_FAILED",
    );
    db.close();
  });
});
