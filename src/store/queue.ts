import { Database } from "bun:sqlite";

import { addMs } from "../contracts/clock";
import type { ErrorCode } from "../contracts/errors";
import type { ItemId, RequestId, UserId } from "../contracts/ids";
import type { FetchRequest } from "../contracts/item";
import { translate, write } from "./db";

export const MAX_ATTEMPTS = 3;

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
    return (
      db
        .query<FetchRequest, [string, string]>(
          `UPDATE fetch_requests
           SET state = 'claimed', lease_expires_at = ?, attempts = attempts + 1
           WHERE id = ? AND state = 'queued'
           RETURNING *`,
        )
        .get(leaseExpiresAt, id) ?? null
    );
  } catch (error) {
    throw translate(error instanceof Error ? error : String(error), {});
  }
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
    .query<{ user_id: UserId; item_id: ItemId }, []>(
      `SELECT user_id, item_id FROM fetch_requests
       WHERE item_id IS NOT NULL AND state IN ('queued', 'claimed')`,
    )
    .all()
    .map((row) => `${row.user_id}/${row.item_id}`);
}

export function sweepStaleLeases(
  db: Database,
  now: Date,
): { requeued: string[]; failed: string[] } {
  const nowIso = now.toISOString();
  const sweep = db.transaction(() => {
    const requeued = db
      .query<{ id: RequestId }, [string, number]>(
        `UPDATE fetch_requests
         SET state = 'queued', lease_expires_at = NULL
         WHERE state = 'claimed' AND lease_expires_at <= ? AND attempts < ?
         RETURNING id`,
      )
      .all(nowIso, MAX_ATTEMPTS)
      .map((row) => row.id);
    const failed = db
      .query<{ id: RequestId }, [string, number]>(
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

  try {
    return sweep.immediate();
  } catch (error) {
    throw translate(error instanceof Error ? error : String(error), {});
  }
}
