import { Database, SQLiteError } from "bun:sqlite";

import { AppError } from "../contracts/errors";
import type { ApiToken, User } from "../contracts/item";

const USER_COLUMNS = `id, subject, email, created_at`;
const TOKEN_COLUMNS = `id, user_id, name, token_hash, created_at, last_used_at`;

function translate(error: unknown, context: Record<string, unknown>): unknown {
  if (error instanceof SQLiteError) {
    const code = error.code ?? "";
    if (code.includes("CONSTRAINT_UNIQUE") || code.includes("CONSTRAINT_PRIMARYKEY")) {
      return new AppError("STORE_CONFLICT", error.message, context);
    }
    if (code.includes("CONSTRAINT")) {
      return new AppError("STORE_CONSTRAINT_FAILED", error.message, context);
    }
    if (code === "SQLITE_BUSY") {
      return new AppError("STORE_BUSY", error.message, context);
    }
  }
  return error;
}

export function insertUser(db: Database, user: User): User {
  try {
    db.run(
      "INSERT INTO users (id, subject, email, created_at) VALUES (?, ?, ?, ?)",
      [user.id, user.subject, user.email, user.created_at],
    );
  } catch (error) {
    throw translate(error, { id: user.id, subject: user.subject });
  }
  return user;
}

export function getUser(db: Database, id: string): User | null {
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
  try {
    db.run(
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
    );
  } catch (error) {
    throw translate(error, { user_id: token.user_id, id: token.id });
  }
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

export function listApiTokens(db: Database, userId: string): ApiToken[] {
  return db
    .query<ApiToken, [string]>(
      `SELECT ${TOKEN_COLUMNS} FROM api_tokens WHERE user_id = ?
       ORDER BY created_at DESC, id DESC`,
    )
    .all(userId);
}

export function touchApiToken(
  db: Database,
  userId: string,
  id: string,
  now: Date,
): void {
  db.run(
    "UPDATE api_tokens SET last_used_at = ? WHERE user_id = ? AND id = ?",
    [now.toISOString(), userId, id],
  );
}

export function deleteApiToken(
  db: Database,
  userId: string,
  id: string,
): void {
  db.run("DELETE FROM api_tokens WHERE user_id = ? AND id = ?", [userId, id]);
}
