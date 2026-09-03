import { Database } from "bun:sqlite";

import { addMs } from "../contracts/clock";
import type { ErrorCode } from "../contracts/errors";
import {
  asItemId,
  asRequestId,
  asUserId,
  type ItemId,
  type RequestId,
  type UserId,
} from "../contracts/ids";
import type { FetchRequest } from "../contracts/item";
import { translate, write } from "./db";

export const MAX_ATTEMPTS = 3;

type FetchRequestRow = {
  id: string;
  user_id: string;
  item_id: string | null;
  url: string;
  state: FetchRequest["state"];
  lease_expires_at: string | null;
  attempts: number;
  error_code: string | null;
  created_at: string;
};

function requestOf(row: FetchRequestRow): FetchRequest {
  return {
    ...row,
    id: asRequestId(row.id),
    user_id: asUserId(row.user_id),
    item_id: row.item_id === null ? null : asItemId(row.item_id),
  };
}

export function enqueueFetch(
  db: Database,
  request: FetchRequest,
): FetchRequest {
  write(
    db,
    `INSERT INTO fetch_requests (
       id, user_id, item_id, url, state,
       lease_expires_at, attempts, error_code, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      request.id,
      request.user_id,
      request.item_id,
      request.url,
      request.state,
      request.lease_expires_at,
      request.attempts,
      request.error_code,
      request.created_at,
    ],
    { id: request.id, user_id: request.user_id },
  );
  return request;
}

export function claimNext(
  db: Database,
  now: Date,
  leaseMs: number,
): FetchRequest | null {
  const leaseExpiresAt = addMs(now, leaseMs).toISOString();
  try {
    const row = db
      .query<FetchRequestRow, [string]>(
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
      .get(leaseExpiresAt);
    return row === null ? null : requestOf(row);
  } catch (error) {
    throw translate(error instanceof Error ? error : String(error), {});
  }
}

// Foreground ingest claims its own request instead of taking the oldest one.
export function claimRequest(
  db: Database,
  id: RequestId,
  now: Date,
  leaseMs: number,
): FetchRequest | null {
  const leaseExpiresAt = addMs(now, leaseMs).toISOString();
  try {
    const row = db
      .query<FetchRequestRow, [string, string]>(
        `UPDATE fetch_requests
         SET state = 'claimed', lease_expires_at = ?, attempts = attempts + 1
         WHERE id = ? AND state = 'queued'
         RETURNING *`,
      )
      .get(leaseExpiresAt, id);
    return row === null ? null : requestOf(row);
  } catch (error) {
    throw translate(error instanceof Error ? error : String(error), {});
  }
}

export function getFetchRequest(
  db: Database,
  userId: UserId,
  id: RequestId,
): FetchRequest | null {
  const row = db
    .query<FetchRequestRow, [string, string]>(
      `SELECT id, user_id, item_id, url, state, lease_expires_at,
              attempts, error_code, created_at
       FROM fetch_requests
       WHERE user_id = ? AND id = ?`,
    )
    .get(userId, id);
  return row === null ? null : requestOf(row);
}

export function listSaveRequests(
  db: Database,
  userId: UserId,
  limit: number,
): FetchRequest[] {
  return db
    .query<FetchRequestRow, [string, number]>(
      `SELECT id, user_id, item_id, url, state, lease_expires_at,
              attempts, error_code, created_at
       FROM fetch_requests
       WHERE user_id = ? AND state IN ('queued', 'claimed', 'failed')
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(userId, limit)
    .map(requestOf);
}

export function completeFetch(
  db: Database,
  id: RequestId,
  attempts: number,
  itemId: ItemId,
): boolean {
  return (
    write(
      db,
      `UPDATE fetch_requests
       SET state = 'done', lease_expires_at = NULL, item_id = ?, error_code = NULL
       WHERE id = ? AND state = 'claimed' AND attempts = ?`,
      [itemId, id, attempts],
      { id, item_id: itemId },
    ) === 1
  );
}

export function failFetch(
  db: Database,
  id: RequestId,
  attempts: number,
  errorCode: ErrorCode,
): boolean {
  return (
    write(
      db,
      `UPDATE fetch_requests
       SET state = 'failed', lease_expires_at = NULL, error_code = ?
       WHERE id = ? AND state = 'claimed' AND attempts = ?`,
      [errorCode, id, attempts],
      { id },
    ) === 1
  );
}

// Reserve an item directory while the request remains active. The item row is
// written only after its files are complete, so the reservation needs no FK.
export function reserveItem(
  db: Database,
  id: RequestId,
  attempts: number,
  itemId: ItemId,
): boolean {
  return (
    write(
      db,
      `UPDATE fetch_requests
       SET item_id = ?
       WHERE id = ? AND state = 'claimed' AND attempts = ?`,
      [itemId, id, attempts],
      { id, item_id: itemId },
    ) === 1
  );
}

export function releaseFetch(
  db: Database,
  id: RequestId,
  attempts: number,
  errorCode: ErrorCode,
): boolean {
  return (
    write(
      db,
      `UPDATE fetch_requests
       SET state = 'queued', lease_expires_at = NULL, error_code = ?
       WHERE id = ? AND state = 'claimed' AND attempts = ?`,
      [errorCode, id, attempts],
      { id },
    ) === 1
  );
}

export function pendingItemPaths(db: Database): string[] {
  return db
    .query<{ user_id: string; item_id: string }, []>(
      `SELECT user_id, item_id FROM fetch_requests
       WHERE item_id IS NOT NULL AND state IN ('queued', 'claimed')`,
    )
    .all()
    .map((row) => `${asUserId(row.user_id)}/${asItemId(row.item_id)}`);
}

export function sweepStaleLeases(
  db: Database,
  now: Date,
): { requeued: string[]; failed: string[] } {
  const nowIso = now.toISOString();
  const sweep = db.transaction(() => {
    const requeued = db
      .query<{ id: string }, [string, number]>(
        `UPDATE fetch_requests
         SET state = 'queued', lease_expires_at = NULL
         WHERE state = 'claimed' AND lease_expires_at <= ? AND attempts < ?
         RETURNING id`,
      )
      .all(nowIso, MAX_ATTEMPTS)
      .map((row) => asRequestId(row.id));
    const failed = db
      .query<{ id: string }, [string, number]>(
        `UPDATE fetch_requests
         SET state = 'failed', lease_expires_at = NULL,
             error_code = 'INGEST_ATTEMPTS_EXHAUSTED'
         WHERE state = 'claimed' AND lease_expires_at <= ? AND attempts >= ?
         RETURNING id`,
      )
      .all(nowIso, MAX_ATTEMPTS)
      .map((row) => asRequestId(row.id));
    return { requeued, failed };
  });

  try {
    return sweep.immediate();
  } catch (error) {
    throw translate(error instanceof Error ? error : String(error), {});
  }
}
