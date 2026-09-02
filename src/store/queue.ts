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
    // Select and update in one statement so concurrent workers can't claim the
    // same request.
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

// Claims a specific request for foreground ingest. The atomic
// `UPDATE ... RETURNING` prevents concurrent claims and increments the attempt
// counter used by later ownership checks.
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

// Match `attempts` so a worker with an expired lease can't commit after a new
// worker claims the request.
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

// Reserves an item ID while the request remains claimed. The orphan sweep
// preserves directories referenced by queued and claimed requests.
//
// The item row doesn't exist until ingest commits, so `fetch_requests.item_id`
// can't use a foreign key.
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

// Returns a failed request to the queue and records the error. Matching
// `attempts` prevents a worker with an expired lease from updating the row.
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

// Returns reserved item paths across all tenants for the orphan sweep. Only
// queued and claimed requests need protection. Completed items appear in
// `itemPaths`, and failed requests don't run again. Don't use this unscoped
// query in request handling.
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

  // Create one transaction for both updates so a worker can't claim a request
  // between them.
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

  // Acquire the write lock before either update runs.
  try {
    return sweep.immediate();
  } catch (error) {
    throw translate(error, {});
  }
}
