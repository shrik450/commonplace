import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { AppError, isAppError } from "../../src/contracts/errors";
import type { ErrorCode } from "../../src/contracts/errors";
import type { Item } from "../../src/contracts/item";
import type {
  Annotation,
  ApiToken,
  FetchRequest,
  User,
} from "../../src/contracts/item";
import { migrate } from "../../src/store/db";
import { insertItem } from "../../src/store/items";
import { insertAnnotation } from "../../src/store/annotations";
import { insertApiToken, insertUser } from "../../src/store/users";
import { claimNext, completeFetch, enqueueFetch } from "../../src/store/queue";
import { indexItem, searchItems } from "../../src/store/fts";

const NOW = new Date("2026-01-01T00:00:00.000Z");

function makeDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, NOW);
  return db;
}

function seedUser(db: Database, over: Partial<User> = {}): User {
  const user: User = {
    id: "user-1",
    subject: "subject-1",
    email: null,
    created_at: NOW.toISOString(),
    ...over,
  };
  return insertUser(db, user);
}

function makeItem(over: Partial<Item> = {}): Item {
  return {
    id: "item-1",
    user_id: "user-1",
    kind: "article",
    url: "https://example.test/a",
    title: "A title",
    author: null,
    created_at: NOW.toISOString(),
    ingested_at: null,
    ...over,
  };
}

function makeAnnotation(over: Partial<Annotation> = {}): Annotation {
  return {
    id: "ann-1",
    user_id: "user-1",
    item_id: "item-1",
    start_offset: 0,
    end_offset: 1,
    quote: "q",
    note: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...over,
  };
}

function makeToken(over: Partial<ApiToken> = {}): ApiToken {
  return {
    id: "token-1",
    user_id: "user-1",
    name: "cli",
    token_hash: "hash-1",
    created_at: NOW.toISOString(),
    last_used_at: null,
    ...over,
  };
}

function makeFetch(over: Partial<FetchRequest> = {}): FetchRequest {
  return {
    id: "fetch-1",
    user_id: "user-1",
    item_id: null,
    url: "https://example.test/f",
    source_path: null,
    state: "queued",
    lease_expires_at: null,
    attempts: 0,
    error_code: null,
    created_at: NOW.toISOString(),
    ...over,
  };
}

// The raw SQLiteError also throws, so "it throws" proves nothing here. The
// only acceptable shape is an AppError whose code names a STORE_* failure.
function expectStoreError(fn: () => unknown, code?: ErrorCode): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(isAppError(thrown)).toBe(true);
  const appError = thrown as AppError;
  expect(appError.code.startsWith("STORE_")).toBe(true);
  if (code !== undefined) {
    expect(appError.code).toBe(code);
  }
}

describe("store errors leave as AppError with a STORE_ code", () => {
  test("insertItem with a duplicate url is a conflict", () => {
    const db = makeDb();
    seedUser(db);
    insertItem(db, makeItem());
    expectStoreError(
      () => insertItem(db, makeItem({ id: "item-2" })),
      "STORE_CONFLICT",
    );
  });

  test("insertItem with a rejected kind is a constraint failure", () => {
    const db = makeDb();
    seedUser(db);
    expectStoreError(
      () => insertItem(db, makeItem({ kind: "video" as Item["kind"] })),
      "STORE_CONSTRAINT_FAILED",
    );
  });

  test("insertAnnotation with an unknown item_id fails with a STORE_ code", () => {
    const db = makeDb();
    seedUser(db);
    expectStoreError(() =>
      insertAnnotation(db, makeAnnotation({ item_id: "no-item" })),
    );
  });

  test("insertUser with a duplicate subject is a conflict", () => {
    const db = makeDb();
    seedUser(db);
    expectStoreError(
      () => seedUser(db, { id: "user-2" }),
      "STORE_CONFLICT",
    );
  });

  test("insertApiToken with a duplicate token_hash is a conflict", () => {
    const db = makeDb();
    seedUser(db);
    insertApiToken(db, makeToken());
    expectStoreError(
      () => insertApiToken(db, makeToken({ id: "token-2" })),
      "STORE_CONFLICT",
    );
  });

  test("enqueueFetch with an unknown user_id is a constraint failure", () => {
    const db = makeDb();
    seedUser(db);
    expectStoreError(
      () => enqueueFetch(db, makeFetch({ user_id: "no-user" })),
      "STORE_CONSTRAINT_FAILED",
    );
  });

  test("completeFetch with an unknown item_id is a constraint failure", () => {
    const db = makeDb();
    seedUser(db);
    enqueueFetch(db, makeFetch());
    claimNext(db, NOW, 1_000);
    expectStoreError(
      () => completeFetch(db, "fetch-1", 1, "no-item"),
      "STORE_CONSTRAINT_FAILED",
    );
  });

  test("indexItem against a database with no schema fails with a STORE_ code", () => {
    const db = new Database(":memory:");
    expectStoreError(() =>
      indexItem(db, {
        item_id: "item-1",
        user_id: "user-1",
        title: "A title",
        author: null,
        transcript: "text",
      }),
    );
  });

  test("searchItems against a database with no schema fails with a STORE_ code", () => {
    const db = new Database(":memory:");
    expectStoreError(() => searchItems(db, "user-1", "query", 10));
  });
});
