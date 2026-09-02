import { Database } from "bun:sqlite";

import { addMs } from "../contracts/clock";
import type { ErrorCode } from "../contracts/errors";
import type { ItemId, RequestId, UserId } from "../contracts/ids";
import type { FetchRequest } from "../contracts/item";
import { translate, write } from "./db";

export const MAX_ATTEMPTS = 3;

const REQUEST_COLUMNS = `
  id, user_id, item_id, url, source_path, state,
  lease_expires_at, attempts, error_code, created_at
`;

export function enqueueFetch(
  db: Database,
  request: FetchRequest,
): FetchRequest {
  write(
    db,
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

// Claims one specific request by id, the way the foreground "cp ingest"
// command does. Same atomic UPDATE ... RETURNING as claimNext, so two callers
// cannot claim the same row: a second claim on a claimed or done row returns
// null. Raises attempts the same way, so the attempts fence stays honest.
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
    throw translate(error, {});
  }
}

// The fence on `attempts` keeps a worker whose lease expired from committing
// over the worker that replaced it. `changes === 1` is the only signal that
// the caller still owns the lease.
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

// Puts the reserved item id on the row while it stays claimed. The sweep
// reads item_id from queued and claimed requests, so a crash after this
// write leaves the item directory protected until the request settles.
//
// The reservation is deliberately dangling: item_id names an item row the
// commit step has not written yet, and a crash must leave it that way. That
// is why fetch_requests.item_id carries no foreign key.
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

// Returns a request to the queue after a retryable failure, clearing the
// lease and recording why the last attempt failed. Same fence as completeFetch.
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

// The other cross-tenant read in the store, and the partner of itemPaths.
// It exists only for the orphan sweep, which runs across all tenants; do not
// copy this pattern into a request path. Only queued and claimed requests
// hold directories the sweep must protect: a done request's item is already
// in itemPaths, and a failed request will never run again, so its directory
// is garbage the sweep must collect.
export function pendingItemPaths(db: Database): string[] {
  return db
    .query<{ user_id: UserId; item_id: ItemId }, []>(
      `SELECT user_id, item_id FROM fetch_requests
       WHERE item_id IS NOT NULL AND state IN ('queued', 'claimed')`,
    )
    .all()
    .map((row) => `${row.user_id}/${row.item_id}`);
}

export function listFetchRequests(
  db: Database,
  userId: UserId,
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
  userId: UserId,
  id: RequestId,
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

  // One transaction, so no worker can claim a row between the two updates
  // and have the second flip it to failed underneath itself.
  try {
    return sweep.immediate();
  } catch (error) {
    throw translate(error, {});
  }
}
