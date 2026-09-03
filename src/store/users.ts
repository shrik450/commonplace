import { Database } from "bun:sqlite";

import { asUserId, type TokenId, type UserId } from "../contracts/ids";
import { DEFAULT_SETTINGS } from "../contracts/settings";
import type { ApiToken, User } from "../contracts/item";
import { write } from "./db";

const USER_COLUMNS = `id, subject, email, created_at`;
const TOKEN_COLUMNS = `id, user_id, name, token_hash, created_at, last_used_at`;

type UserRow = Omit<User, "id"> & { id: string };
type TokenRow = Omit<ApiToken, "user_id"> & { user_id: string };

function userOf(row: UserRow): User {
  return { ...row, id: asUserId(row.id) };
}

function tokenOf(row: TokenRow): ApiToken {
  return { ...row, user_id: asUserId(row.user_id) };
}

export function insertUser(db: Database, user: User): User {
  const insert = db.transaction(() => {
    write(
      db,
      "INSERT INTO users (id, subject, email, created_at) VALUES (?, ?, ?, ?)",
      [user.id, user.subject, user.email, user.created_at],
      { id: user.id, subject: user.subject },
    );
    write(
      db,
      "INSERT INTO user_settings (user_id, theme, font, text_size, line_spacing, paragraph_spacing, text_width) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [user.id, DEFAULT_SETTINGS.theme, DEFAULT_SETTINGS.font, DEFAULT_SETTINGS.text_size,
        DEFAULT_SETTINGS.line_spacing, DEFAULT_SETTINGS.paragraph_spacing, DEFAULT_SETTINGS.text_width],
      { user_id: user.id },
    );
  });
  insert();
  return user;
}

export function getUser(db: Database, id: UserId): User | null {
  const row = db.query<UserRow, [string]>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(id);
  return row === null ? null : userOf(row);
}

export function getUserBySubject(db: Database, subject: string): User | null {
  const row = db.query<UserRow, [string]>(`SELECT ${USER_COLUMNS} FROM users WHERE subject = ?`).get(subject);
  return row === null ? null : userOf(row);
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
  const row = db.query<TokenRow, [string]>(`SELECT ${TOKEN_COLUMNS} FROM api_tokens WHERE token_hash = ?`).get(tokenHash);
  return row === null ? null : tokenOf(row);
}

export function listApiTokens(db: Database, userId: UserId): ApiToken[] {
  return db
    .query<TokenRow, [string]>(
      `SELECT ${TOKEN_COLUMNS} FROM api_tokens WHERE user_id = ?
       ORDER BY created_at DESC, id DESC`,
    )
    .all(userId)
    .map(tokenOf);
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
