import { join } from "node:path";

import { addMs, now } from "../contracts/clock";
import { toLogLine } from "../contracts/errors";
import type { FetchRequest } from "../contracts/item";
import { loadConfig } from "../store/config";
import { openDatabase } from "../store/db";
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
import { capture } from "./acquire";
import { ingestRequest } from "./ingest";
import type { IngestDeps, IngestOutcome } from "./ingest";

// The lease must outlast a capture that runs to its timeout, or a slow but
// healthy capture loses its lease mid-run.
export const LEASE_MS = 300_000;
export const IDLE_POLL_MS = 1_000;
export const ORPHAN_GRACE_MS = 3_600_000;

export type WorkerDeps = IngestDeps & {
  leaseMs?: number;
  orphanGraceMs?: number;
};

// Claims one request, runs it, and applies the outcome to the queue.
export async function drainOnce(deps: WorkerDeps): Promise<IngestOutcome | null> {
  const request = claimNext(deps.db, deps.now(), deps.leaseMs ?? LEASE_MS);
  if (request === null) return null;

  const outcome = await ingestRequest(deps, request);

  applyOutcome(deps, request, outcome);
  logOutcome(outcome);
  return outcome;
}

// Applies one outcome to the queue: release for a retry that still has
// attempts, fail when the attempts are spent or the code is permanent. The
// decision about retries and exhaustion lives here, so it cannot disagree
// with itself between two modules. Done needs no write; ingestRequest
// already completed the request.
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

// Three steps, in this order. Step 1 settles the states a dead worker left
// behind, so step 2 reads them as they are, and a request whose attempts ran
// out has its directory collected in the same pass.
export async function sweep(deps: WorkerDeps): Promise<SweepResult> {
  const { requeued, failed } = sweepStaleLeases(deps.db, deps.now());

  const known = new Set([...itemPaths(deps.db), ...pendingItemPaths(deps.db)]);
  const cutoff = addMs(deps.now(), -(deps.orphanGraceMs ?? ORPHAN_GRACE_MS));
  const orphans = await sweepOrphans(deps.itemsRoot, known, cutoff);

  return { requeued, failed, orphans };
}

function logOutcome(outcome: IngestOutcome): void {
  // Logs are diagnostics, so they go to stderr and stdout stays free for
  // the command's answer. A success has no error code, so its line is built
  // here instead of through toLogLine, which would claim "UNKNOWN".
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

// Runs until the stop signal fires. Never throws for a fetch failure; each
// outcome is logged and the loop continues.
export async function runWorker(deps: WorkerDeps, stop: AbortSignal): Promise<void> {
  await sweep(deps);

  let idleTurns = 0;
  while (!stop.aborted) {
    const outcome = await drainOnce(deps);
    if (outcome === null) {
      idleTurns += 1;
      // Sweep again every fiftieth idle turn, so a long-running process
      // still collects orphans left by a crashed sibling.
      if (idleTurns % 50 === 0) await sweep(deps);
      await sleep(IDLE_POLL_MS, stop);
    }
  }
}

// Sleeps, but wakes early when the stop signal fires, so a shutdown never
// waits out a full idle poll.
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

// Runs the loop inside the caller's process and hands back the two controls a
// host needs: ask it to leave, and read whether it has. `stop` resolves only
// after the loop returns, so a shutdown never cuts a capture in half.
export function startWorker(deps: WorkerDeps): Worker {
  const controller = new AbortController();
  let alive = true;

  const finished = runWorker(deps, controller.signal)
    .catch((error: unknown) => {
      console.error(toLogLine("error", error));
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

if (import.meta.main) {
  const config = await loadConfig();
  const db = openDatabase(join(config.db_root, "db.sqlite"), now());
  const stop = new AbortController();
  process.on("SIGTERM", () => stop.abort());
  process.on("SIGINT", () => stop.abort());
  await runWorker(
    {
      db,
      itemsRoot: config.items_root,
      now,
      capture,
      browserPath: config.browser_path,
    },
    stop.signal,
  );
}
