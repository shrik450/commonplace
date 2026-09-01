import { Database, SQLiteError } from "bun:sqlite";

import { addMs } from "../contracts/clock";
import { AppError } from "../contracts/errors";
import type { ErrorCode } from "../contracts/errors";
import type { FetchRequest } from "../contracts/item";

export const MAX_ATTEMPTS = 3;

const REQUEST_COLUMNS = `
  id, user_id, item_id, url, source_path, state,
  lease_expires_at, attempts, error_code, created_at
`;

function translate(error: unknown, context: Record<string, unknown>): unknown {
  if (error instanceof SQLiteError) {
    const code = error.code ?? "";
    if (code.startsWith("SQLITE_BUSY")) {
      return new AppError("STORE_BUSY", error.message, context);
    }
    if (code.includes("CONSTRAINT")) {
      return new AppError("STORE_CONSTRAINT_FAILED", error.message, context);
    }
  }
  return error;
}

export function enqueueFetch(
  db: Database,
  request: FetchRequest,
): FetchRequest {
  try {
    db.run(
      `INSERT INTO fetch_requests (
         id, user_id, item_id, url, source_path, state,
         lease_expires_at, attempts, error_code, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        request.id,
        request.user_id,
        request.item_id,
        request.url,
        request.source_path,
        request.state,
        request.lease_expires_at,
        request.attempts,
        request.error_code,
        request.created_at,
      ],
    );
  } catch (error) {
    throw translate(error, { id: request.id, user_id: request.user_id });
  }
  return request;
}

export function claimNext(
  db: Database,
  now: Date,
  leaseMs: number,
): FetchRequest | null {
  const leaseExpiresAt = addMs(now, leaseMs).toISOString();
  try {
    // One statement, so two workers cannot pick the same row: the subquery
    // and the update commit atomically.
    return (
      db
        .query<FetchRequest, [string]>(
          `UPDATE fetch_requests
           SET state = 'claimed', lease_expires_at = ?, attempts = attempts + 1
           WHERE id = (
             SELECT id FROM fetch_requests
             WHERE state = 'queued'
             ORDER BY created_at, id
             LIMIT 1
           )
           RETURNING *`,
        )
        .get(leaseExpiresAt) ?? null
    );
  } catch (error) {
    throw translate(error, {});
  }
}

// The fence on `attempts` keeps a worker whose lease expired from committing
// over the worker that replaced it. `changes === 1` is the only signal that
// the caller still owns the lease.
export function completeFetch(
  db: Database,
  id: string,
  attempts: number,
  itemId: string,
): boolean {
  try {
    return (
      db.run(
        `UPDATE fetch_requests
         SET state = 'done', lease_expires_at = NULL, item_id = ?, error_code = NULL
         WHERE id = ? AND state = 'claimed' AND attempts = ?`,
        [itemId, id, attempts],
      ).changes === 1
    );
  } catch (error) {
    throw translate(error, { id, item_id: itemId });
  }
}

export function failFetch(
  db: Database,
  id: string,
  attempts: number,
  errorCode: ErrorCode,
): boolean {
  try {
    return (
      db.run(
        `UPDATE fetch_requests
         SET state = 'failed', lease_expires_at = NULL, error_code = ?
         WHERE id = ? AND state = 'claimed' AND attempts = ?`,
        [errorCode, id, attempts],
      ).changes === 1
    );
  } catch (error) {
    throw translate(error, { id });
  }
}

export function listFetchRequests(
  db: Database,
  userId: string,
  limit: number,
): FetchRequest[] {
  return db
    .query<FetchRequest, [string, number]>(
      `SELECT ${REQUEST_COLUMNS} FROM fetch_requests
       WHERE user_id = ?
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(userId, limit);
}

export function getFetchRequest(
  db: Database,
  userId: string,
  id: string,
): FetchRequest | null {
  return (
    db
      .query<FetchRequest, [string, string]>(
        `SELECT ${REQUEST_COLUMNS} FROM fetch_requests
         WHERE user_id = ? AND id = ?`,
      )
      .get(userId, id) ?? null
  );
}

export function sweepStaleLeases(
  db: Database,
  now: Date,
): { requeued: string[]; failed: string[] } {
  const nowIso = now.toISOString();

  // One transaction, so no worker can claim a row between the two updates
  // and have the second flip it to failed underneath itself.
  const sweep = db.transaction(() => {
    const requeued = db
      .query<{ id: string }, [string, number]>(
        `UPDATE fetch_requests
         SET state = 'queued', lease_expires_at = NULL
         WHERE state = 'claimed' AND lease_expires_at <= ? AND attempts < ?
         RETURNING id`,
      )
      .all(nowIso, MAX_ATTEMPTS)
      .map((row) => row.id);
    const failed = db
      .query<{ id: string }, [string, number]>(
        `UPDATE fetch_requests
         SET state = 'failed', lease_expires_at = NULL,
             error_code = 'INGEST_ATTEMPTS_EXHAUSTED'
         WHERE state = 'claimed' AND lease_expires_at <= ? AND attempts >= ?
         RETURNING id`,
      )
      .all(nowIso, MAX_ATTEMPTS)
      .map((row) => row.id);
    return { requeued, failed };
  });

  // One transaction, so no worker can claim a row between the two updates
  // and have the second flip it to failed underneath itself.
  try {
    return sweep.immediate();
  } catch (error) {
    throw translate(error, {});
  }
}
