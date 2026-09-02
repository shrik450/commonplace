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
import { asAnnotationId, asItemId, asRequestId, asTokenId, asUserId } from "../../src/contracts/ids";
import { migrate } from "../../src/store/db";
import { insertItem } from "../../src/store/items";
import { insertAnnotation } from "../../src/store/annotations";
import { insertApiToken, insertUser } from "../../src/store/users";
import { claimNext, completeFetch, enqueueFetch } from "../../src/store/queue";
import type { BlockRow } from "../../src/store/fts";
import { indexBlocks, searchBlocks } from "../../src/store/fts";

const NOW = new Date("2026-01-01T00:00:00.000Z");

// Every id goes through its as* constructor, so a bare string no longer
// compiles where the store asks for a brand.
const USER_1 = asUserId("11111111-1111-4111-8111-111111111111");
const USER_2 = asUserId("11111111-1111-4111-8111-111111111112");
const ITEM_1 = asItemId("22222222-2222-4222-8222-222222222221");
const ITEM_2 = asItemId("22222222-2222-4222-8222-222222222222");
const ANN_1 = asAnnotationId("33333333-3333-4333-8333-333333333331");
const TOKEN_1 = asTokenId("44444444-4444-4444-8444-444444444441");
const FETCH_1 = asRequestId("55555555-5555-4555-8555-555555555551");
// Lexically valid ids that name no row, so a foreign key still rejects them.
const MISSING_ITEM = asItemId("99999999-9999-4999-8999-999999999991");
const MISSING_USER = asUserId("99999999-9999-4999-8999-999999999992");

function makeDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, NOW);
  return db;
}

function seedUser(db: Database, over: Partial<User> = {}): User {
  const user: User = {
    id: USER_1,
    subject: "subject-1",
    email: null,
    created_at: NOW.toISOString(),
    ...over,
  };
  return insertUser(db, user);
}

function makeItem(over: Partial<Item> = {}): Item {
  return {
    id: ITEM_1,
    user_id: USER_1,
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
    id: ANN_1,
    user_id: USER_1,
    item_id: ITEM_1,
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
    id: TOKEN_1,
    user_id: USER_1,
    name: "cli",
    token_hash: "hash-1",
    created_at: NOW.toISOString(),
    last_used_at: null,
    ...over,
  };
}

function makeFetch(over: Partial<FetchRequest> = {}): FetchRequest {
  return {
    id: FETCH_1,
    user_id: USER_1,
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

function makeBlock(over: Partial<BlockRow> = {}): BlockRow {
  return {
    item_id: ITEM_1,
    user_id: USER_1,
    block_index: 0,
    start_offset: 0,
    end_offset: 5,
    is_content: true,
    text: "A short block.",
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
      () => insertItem(db, makeItem({ id: ITEM_2 })),
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
      insertAnnotation(db, makeAnnotation({ item_id: MISSING_ITEM })),
    );
  });

  test("insertUser with a duplicate subject is a conflict", () => {
    const db = makeDb();
    seedUser(db);
    expectStoreError(
      () => seedUser(db, { id: USER_2 }),
      "STORE_CONFLICT",
    );
  });

  test("insertApiToken with a duplicate token_hash is a conflict", () => {
    const db = makeDb();
    seedUser(db);
    insertApiToken(db, makeToken());
    expectStoreError(
      () => insertApiToken(db, makeToken({ id: asTokenId("44444444-4444-4444-8444-444444444442") })),
      "STORE_CONFLICT",
    );
  });

  test("enqueueFetch with an unknown user_id is a constraint failure", () => {
    const db = makeDb();
    seedUser(db);
    expectStoreError(
      () => enqueueFetch(db, makeFetch({ user_id: MISSING_USER })),
      "STORE_CONSTRAINT_FAILED",
    );
  });

  // This case once forced its failure with a foreign key on
  // fetch_requests.item_id. Milestone 5 dropped that key, because a worker
  // reserves an item id before the item row exists. The guarantee under test
  // is unchanged: completeFetch must never leak a raw SQLiteError.
  test("completeFetch against a dropped table fails with a STORE_ code", () => {
    const db = makeDb();
    seedUser(db);
    enqueueFetch(db, makeFetch());
    claimNext(db, NOW, 1_000);
    db.exec("DROP TABLE fetch_requests");
    expectStoreError(() => completeFetch(db, FETCH_1, 1, MISSING_ITEM));
  });

  test("indexBlocks against a database with no schema fails with a STORE_ code", () => {
    const db = new Database(":memory:");
    expectStoreError(() => indexBlocks(db, ITEM_1, [makeBlock()]));
  });

  test("searchBlocks against a database with no schema fails with a STORE_ code", () => {
    const db = new Database(":memory:");
    expectStoreError(() => searchBlocks(db, USER_1, "query", 10));
  });
});
