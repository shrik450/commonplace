import { addMs } from "../contracts/clock";
import { toLogLine } from "../contracts/errors";
import type { FetchRequest } from "../contracts/item";
import { itemPaths } from "../store/items";
import {
  MAX_ATTEMPTS,
  claimNext,
  failFetch,
  pendingItemPaths,
  releaseFetch,
  sweepStaleLeases,
} from "../store/queue";
import { sweepOrphans } from "../store/files";
import { ingestRequest } from "./ingest";
import type { IngestDeps, IngestOutcome } from "./ingest";

// Keep the lease longer than the capture timeout. Otherwise, another worker
// can claim a request while its capture is still running.
export const LEASE_MS = 300_000;
export const IDLE_POLL_MS = 1_000;
export const ORPHAN_GRACE_MS = 3_600_000;

export type WorkerDeps = IngestDeps & {
  leaseMs?: number;
  orphanGraceMs?: number;
};

// Claims and processes the next request, then updates its queue state.
export async function drainOnce(deps: WorkerDeps): Promise<IngestOutcome | null> {
  const request = claimNext(deps.db, deps.now(), deps.leaseMs ?? LEASE_MS);
  if (request === null) return null;

  const outcome = await ingestRequest(deps, request);

  applyOutcome(deps, request, outcome);
  logOutcome(outcome);
  return outcome;
}

// Updates the queue after an ingest attempt. Retryable requests return to the
// queue until they reach `MAX_ATTEMPTS`. `ingestRequest` completes successful
// requests in the same transaction that stores the item.
export function applyOutcome(
  deps: WorkerDeps,
  request: FetchRequest,
  outcome: IngestOutcome,
): void {
  if (outcome.state === "retry") {
    if (request.attempts < MAX_ATTEMPTS) {
      releaseFetch(deps.db, request.id, request.attempts, outcome.code);
    } else {
      failFetch(
        deps.db,
        request.id,
        request.attempts,
        "INGEST_ATTEMPTS_EXHAUSTED",
      );
    }
  } else if (outcome.state === "failed") {
    failFetch(deps.db, request.id, request.attempts, outcome.code);
  }
}

export type SweepResult = {
  requeued: string[];
  failed: string[];
  orphans: string[];
};

// Resolves expired leases before collecting orphan directories. This order
// lets the orphan sweep remove files from requests that have exhausted their
// attempts.
export async function sweep(deps: WorkerDeps): Promise<SweepResult> {
  const { requeued, failed } = sweepStaleLeases(deps.db, deps.now());

  const known = new Set([...itemPaths(deps.db), ...pendingItemPaths(deps.db)]);
  const cutoff = addMs(deps.now(), -(deps.orphanGraceMs ?? ORPHAN_GRACE_MS));
  const orphans = await sweepOrphans(deps.itemsRoot, known, cutoff);

  return { requeued, failed, orphans };
}

function logOutcome(outcome: IngestOutcome): void {
  // Write diagnostics to stderr so stdout remains available for command
  // output. Build successful events directly because they have no error code.
  if (outcome.state === "done") {
    console.error(
      JSON.stringify({ level: "info", msg: "ingest done", item_id: outcome.itemId }),
    );
    return;
  }
  console.error(
    toLogLine("warn", outcome.message, {
      state: outcome.state,
      code: outcome.code,
    }),
  );
}

// Processes requests until `stop` aborts. An ingest failure updates the queue
// and doesn't stop the worker.
export async function runWorker(deps: WorkerDeps, stop: AbortSignal): Promise<void> {
  await sweep(deps);

  let idleTurns = 0;
  while (!stop.aborted) {
    const outcome = await drainOnce(deps);
    if (outcome === null) {
      idleTurns += 1;
      // Repeat the sweep during idle periods to collect files that another
      // process left behind after the initial sweep.
      if (idleTurns % 50 === 0) await sweep(deps);
      await sleep(IDLE_POLL_MS, stop);
    }
  }
}

// Resolves when the delay ends or `stop` aborts.
function sleep(ms: number, stop: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      stop.removeEventListener("abort", finish);
      resolve();
    }
    stop.addEventListener("abort", finish, { once: true });
  });
}

export type Worker = {
  stop: () => Promise<void>;
  running: () => boolean;
};

// Starts the worker in the current process. `stop` waits for the loop to exit,
// including any ingest attempt in progress.
export function startWorker(deps: WorkerDeps): Worker {
  const controller = new AbortController();
  let alive = true;

  const finished = runWorker(deps, controller.signal)
    .catch((error) => {
      const event = error instanceof Error ? error : String(error);
      console.error(toLogLine("error", event));
    })
    .finally(() => {
      alive = false;
    });

  return {
    stop: async () => {
      controller.abort();
      await finished;
    },
    running: () => alive,
  };
}
