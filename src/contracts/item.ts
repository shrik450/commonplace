import type {
  AnnotationId,
  ItemId,
  RequestId,
  TokenId,
  UserId,
} from "./ids";

export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue | undefined };

// JSON.parse returns valid JSON values by definition; this named boundary type
// prevents untrusted JSON from leaking as an unbounded object.
export function parseJsonValue(text: string): JsonValue {
  // SAFETY: JSON.parse accepts only JSON primitives, arrays, and objects, which match JsonValue.
  return JSON.parse(text) as JsonValue;
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && !Array.isArray(value) && Object(value) === value;
}

export function isStringValue(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}

export function isNumberValue(value: JsonValue | undefined): value is number {
  return typeof value === "number";
}
export type FetchState = "queued" | "claimed" | "done" | "failed";

export type Item = {
  id: ItemId;
  user_id: UserId;
  url: string;
  title: string;
  author: string | null;
  created_at: string;
  ingested_at: string | null;
};

export type Annotation = {
  id: AnnotationId;
  user_id: UserId;
  item_id: ItemId;
  start_offset: number;
  end_offset: number;
  quote: string;
  note: string | null;
  created_at: string;
  updated_at: string;
};

export type User = {
  id: UserId;
  subject: string;
  email: string | null;
  created_at: string;
};

export type ApiToken = {
  id: TokenId;
  user_id: UserId;
  name: string;
  token_hash: string;
  created_at: string;
  last_used_at: string | null;
};

export type FetchRequest = {
  id: RequestId;
  user_id: UserId;
  item_id: ItemId | null;
  url: string;
  state: FetchState;
  lease_expires_at: string | null;
  attempts: number;
  error_code: string | null;
  created_at: string;
};
