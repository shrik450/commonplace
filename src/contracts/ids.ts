import { AppError } from "./errors";

declare const brand: unique symbol;
type Branded<K extends string> = string & { readonly [brand]: K };

export type UserId = Branded<"UserId">;
export type ItemId = Branded<"ItemId">;
export type AnnotationId = Branded<"AnnotationId">;
export type TokenId = Branded<"TokenId">;
export type RequestId = Branded<"RequestId">;

// Generates secrets for PKCE, OpenID Connect state and nonce values, and API
// tokens. Keeping random byte generation here makes it auditable.
export function newSecret(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function brandOf<K extends string>(kind: K, value: string): Branded<K> {
  if (!UUID_PATTERN.test(value)) {
    throw new AppError("STORE_INVALID_PATH", `${kind} is not a lowercase UUID`, {
      [kind]: value,
    });
  }
  return value as Branded<K>;
}

export function newUserId(): UserId {
  return Bun.randomUUIDv7() as UserId;
}

export function newItemId(): ItemId {
  return Bun.randomUUIDv7() as ItemId;
}

export function newAnnotationId(): AnnotationId {
  return Bun.randomUUIDv7() as AnnotationId;
}

export function newTokenId(): TokenId {
  return Bun.randomUUIDv7() as TokenId;
}

export function newRequestId(): RequestId {
  return Bun.randomUUIDv7() as RequestId;
}

export function asUserId(value: string): UserId {
  return brandOf("UserId", value);
}

export function asItemId(value: string): ItemId {
  return brandOf("ItemId", value);
}

export function asAnnotationId(value: string): AnnotationId {
  return brandOf("AnnotationId", value);
}

export function asTokenId(value: string): TokenId {
  return brandOf("TokenId", value);
}

export function asRequestId(value: string): RequestId {
  return brandOf("RequestId", value);
}
