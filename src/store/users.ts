import { Database } from "bun:sqlite";

import type { TokenId, UserId } from "../contracts/ids";
import type { ApiToken, User } from "../contracts/item";
import { write } from "./db";

const USER_COLUMNS = `id, subject, email, created_at`;
const TOKEN_COLUMNS = `id, user_id, name, token_hash, created_at, last_used_at`;

export function insertUser(db: Database, user: User): User {
  write(
    db,
    "INSERT INTO users (id, subject, email, created_at) VALUES (?, ?, ?, ?)",
    [user.id, user.subject, user.email, user.created_at],
    { id: user.id, subject: user.subject },
  );
  return user;
}

export function getUser(db: Database, id: UserId): User | null {
  return (
    db.query<User, [string]>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`)
      .get(id) ?? null
  );
}

export function getUserBySubject(db: Database, subject: string): User | null {
  return (
    db
      .query<User, [string]>(
        `SELECT ${USER_COLUMNS} FROM users WHERE subject = ?`,
      )
      .get(subject) ?? null
  );
}

export function insertApiToken(db: Database, token: ApiToken): ApiToken {
  write(
    db,
    `INSERT INTO api_tokens (id, user_id, name, token_hash, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      token.id,
      token.user_id,
      token.name,
      token.token_hash,
      token.created_at,
      token.last_used_at,
    ],
    { user_id: token.user_id, id: token.id },
  );
  return token;
}

export function getApiTokenByHash(
  db: Database,
  tokenHash: string,
): ApiToken | null {
  return (
    db
      .query<ApiToken, [string]>(
        `SELECT ${TOKEN_COLUMNS} FROM api_tokens WHERE token_hash = ?`,
      )
      .get(tokenHash) ?? null
  );
}

export function listApiTokens(db: Database, userId: UserId): ApiToken[] {
  return db
    .query<ApiToken, [string]>(
      `SELECT ${TOKEN_COLUMNS} FROM api_tokens WHERE user_id = ?
       ORDER BY created_at DESC, id DESC`,
    )
    .all(userId);
}

export function touchApiToken(
  db: Database,
  userId: UserId,
  id: TokenId,
  now: Date,
): void {
  write(
    db,
    "UPDATE api_tokens SET last_used_at = ? WHERE user_id = ? AND id = ?",
    [now.toISOString(), userId, id],
    { user_id: userId, id },
  );
}

export function deleteApiToken(
  db: Database,
  userId: UserId,
  id: TokenId,
): void {
  write(
    db,
    "DELETE FROM api_tokens WHERE user_id = ? AND id = ?",
    [userId, id],
    { user_id: userId, id },
  );
}
