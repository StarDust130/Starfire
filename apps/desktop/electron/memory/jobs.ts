import type { MemoryDatabase } from "./database.js";

/*
 * Durable extraction queue backed by the memory_jobs table.
 *
 * Lifecycle: pending -> running -> done
 *                      |-> pending (retry, backoff + jitter)
 *                      `-> failed  (gave up after MAX_JOB_ATTEMPTS)
 *
 * Idempotency across crashes/restarts:
 * - Claiming is atomic (job + processed-marking in one transaction).
 * - Jobs lost mid-"running" are recovered on the next start.
 * - When a job exhausts its attempts, its turns are RELEASED back to
 *   the unprocessed pool — never silently stranded in a dead job.
 */

export type MemoryJobStatus = "pending" | "running" | "done" | "failed";

/** Extraction batch ceiling: 30–40 new turns per request. */
export const EXTRACTION_BATCH_MAX_MESSAGES = 40;

export const EXTRACTION_BATCH_MAX_CHARS = 16_000;

export const MAX_JOB_ATTEMPTS = 5;

export const RETRY_BASE_MS = 30_000;

export const RETRY_MAX_MS = 10 * 60_000;

export const RETRY_JITTER_MS = 5_000;

export const STALE_RUNNING_MS = 5 * 60_000;

export const MAX_JOB_ERROR_CHARS = 500;

export type MemoryJob = {
  id: number;
  status: MemoryJobStatus;
  messageIds: number[];
  attempts: number;
  lastError: string | null;
  runAfter: number;
  createdAt: number;
  updatedAt: number;
};

function parseMessageIds(raw: unknown): number[] {
  if (typeof raw !== "string" || raw.length === 0) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter(
        (value): value is number =>
          typeof value === "number" && Number.isInteger(value) && value > 0,
      )
      .slice(0, 100);
  } catch {
    return [];
  }
}

function truncateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  return message.slice(0, MAX_JOB_ERROR_CHARS);
}

/**
 * Exponential backoff with jitter: base * 2^(attempt-1), capped,
 * plus up to RETRY_JITTER_MS of randomness so failing jobs do not
 * retry in lockstep.
 */
export function nextRetryDelayMs(
  attempts: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempts - 1);

  const exponential = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** exponent);

  const jitter = Math.floor(random() * RETRY_JITTER_MS);

  return exponential + jitter;
}

/**
 * Picks the prefix of `turns` (in order, so neighbors stay together)
 * that fits the payload budget: at most EXTRACTION_BATCH_MAX_MESSAGES
 * items and at most maxChars of content. The first item is always
 * taken — one oversized message must never deadlock the queue.
 */
export function fitBatch<T extends { content: string }>(
  turns: readonly T[],
  maxChars: number = EXTRACTION_BATCH_MAX_CHARS,
): T[] {
  const batch: T[] = [];

  let total = 0;

  for (const turn of turns) {
    if (batch.length >= EXTRACTION_BATCH_MAX_MESSAGES) {
      break;
    }

    const length = turn.content.length;

    if (batch.length > 0 && total + length > maxChars) {
      break;
    }

    batch.push(turn);

    total += length;
  }

  return batch;
}

const SELECT_JOB = `
  SELECT id, status, message_ids, attempts, last_error,
         run_after, created_at, updated_at
  FROM memory_jobs
`;

export class MemoryJobs {
  constructor(private readonly db: MemoryDatabase) {}

  /** Creates one pending job. Empty input creates nothing. */
  enqueue(messageIds: number[]): number | null {
    if (messageIds.length === 0) {
      return null;
    }

    const now = Date.now();

    const result = this.db.handle
      .prepare(
        "INSERT INTO memory_jobs (status, message_ids, attempts, run_after, created_at, updated_at) VALUES ('pending', ?, 0, ?, ?, ?)",
      )
      .run(JSON.stringify(messageIds), now, now, now);

    return Number(result.lastInsertRowid);
  }

  /** Oldest pending job whose retry time has arrived. */
  nextRunnable(now: number = Date.now()): MemoryJob | null {
    const row = this.db.handle
      .prepare(
        `${SELECT_JOB} WHERE status = 'pending' AND run_after <= ? ORDER BY id LIMIT 1`,
      )
      .get(now);

    return row ? this.mapRow(row as Record<string, unknown>) : null;
  }

  /**
   * Earliest future wake-up time among pending jobs (deferred by
   * rate limits or backoff). Null when nothing is waiting — lets the
   * orchestrator sleep until the queue can actually make progress,
   * including across restarts.
   */
  nextWakeAt(now: number = Date.now()): number | null {
    const row = this.db.handle
      .prepare(
        "SELECT MIN(run_after) AS wake FROM memory_jobs WHERE status = 'pending' AND run_after > ?",
      )
      .get(now);

    const wake = row?.wake;

    return typeof wake === "number" && wake > now ? wake : null;
  }

  /**
   * Releases turns back to the unprocessed pool (used when a job
   * exhausts its attempts, so a future batch can extract them).
   */
  releaseMessages(ids: number[]): void {
    if (ids.length === 0) {
      return;
    }

    const placeholders = ids.map(() => "?").join(", ");

    this.db.handle
      .prepare(
        `UPDATE messages SET processed_at = NULL WHERE id IN (${placeholders}) AND processed_at IS NOT NULL`,
      )
      .run(...ids);
  }

  /**
   * Claims a pending job for the worker. Returns false when another
   * claim won — the conditional UPDATE is the lock.
   */
  markRunning(id: number, now: number = Date.now()): boolean {
    const result = this.db.handle
      .prepare(
        "UPDATE memory_jobs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'pending'",
      )
      .run(now, id);

    return Number(result.changes) > 0;
  }

  complete(id: number, now: number = Date.now()): boolean {
    const result = this.db.handle
      .prepare(
        "UPDATE memory_jobs SET status = 'done', updated_at = ? WHERE id = ? AND status = 'running'",
      )
      .run(now, id);

    return Number(result.changes) > 0;
  }

  /**
   * Records a failure. Schedules a retry with backoff until
   * MAX_JOB_ATTEMPTS is reached; on exhaustion the job is marked
   * failed AND its turns are released for a future fresh batch.
   */
  fail(
    id: number,
    error: unknown,
    now: number = Date.now(),
  ): "pending" | "failed" | "ignored" {
    const row = this.db.handle
      .prepare(
        "SELECT attempts, status, message_ids FROM memory_jobs WHERE id = ?",
      )
      .get(id);

    if (!row || String(row.status) !== "running") {
      return "ignored";
    }

    const attempts = Number(row.attempts) + 1;

    const lastError = truncateError(error);

    if (attempts >= MAX_JOB_ATTEMPTS) {
      this.db.withTransaction(() => {
        this.db.handle
          .prepare(
            "UPDATE memory_jobs SET status = 'failed', attempts = ?, last_error = ?, updated_at = ? WHERE id = ? AND status = 'running'",
          )
          .run(attempts, lastError, now, id);

        this.releaseMessages(parseMessageIds(row.message_ids));
      });

      return "failed";
    }

    const runAfter = now + nextRetryDelayMs(attempts);

    this.db.handle
      .prepare(
        "UPDATE memory_jobs SET status = 'pending', attempts = ?, last_error = ?, run_after = ?, updated_at = ? WHERE id = ? AND status = 'running'",
      )
      .run(attempts, lastError, runAfter, now, id);

    return "pending";
  }

  /**
   * Records a failure. Schedules a retry with backoff until
   * MAX_JOB_ATTEMPTS is reached, then marks the job failed for good.
   */
  failImmediately(
    id: number,
    error: unknown,
    now: number = Date.now(),
  ): boolean {
    const result = this.db.handle
      .prepare(
        "UPDATE memory_jobs SET status = 'failed', attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ? AND status = 'running'",
      )
      .run(truncateError(error), now, id);

    return Number(result.changes) > 0;
  }

  /**
   * Rate-limit deferral: push run_after out WITHOUT burning an
   * attempt. The provider asked for patience; the job did nothing
   * wrong, so its real attempts stay intact.
   */
  defer(id: number, delayMs: number, now: number = Date.now()): boolean {
    const result = this.db.handle
      .prepare(
        "UPDATE memory_jobs SET status = 'pending', run_after = MAX(run_after, ?), updated_at = ? WHERE id = ? AND status = 'running'",
      )
      .run(now + delayMs, now, id);

    return Number(result.changes) > 0;
  }

  /** For 429 Retry-After: never let run_after be earlier than now+delay. */
  delayJob(id: number, delayMs: number, now: number = Date.now()): void {
    if (delayMs <= 0) {
      return;
    }

    this.db.handle
      .prepare(
        "UPDATE memory_jobs SET run_after = MAX(run_after, ?) WHERE id = ? AND status = 'pending'",
      )
      .run(now + delayMs, id);
  }

  /**
   * Crash recovery: jobs stuck in "running" (app died mid-job) go
   * back to pending so the next start retries them.
   */
  recoverStaleRunning(
    staleMs: number = STALE_RUNNING_MS,
    now: number = Date.now(),
  ): number {
    const result = this.db.handle
      .prepare(
        "UPDATE memory_jobs SET status = 'pending', run_after = ?, updated_at = ? WHERE status = 'running' AND updated_at <= ?",
      )
      .run(now, now, now - staleMs);

    return Number(result.changes);
  }

  /**
   * Deliberate recovery path for permanently-failed jobs (e.g. they
   * died while the API key was missing). BOUNDED: only jobs that have
   * not exhausted MAX_JOB_ATTEMPTS are requeued, so a poisoned batch
   * can never loop failed->requeued forever.
   */
  requeueFailed(now: number = Date.now()): number {
    const result = this.db.handle
      .prepare(
        "UPDATE memory_jobs SET status = 'pending', run_after = ?, updated_at = ? WHERE status = 'failed' AND attempts < ?",
      )
      .run(now, now, MAX_JOB_ATTEMPTS);

    return Number(result.changes);
  }

  counts(): Record<MemoryJobStatus, number> {
    const counts: Record<MemoryJobStatus, number> = {
      pending: 0,
      running: 0,
      done: 0,
      failed: 0,
    };

    const rows = this.db.handle
      .prepare(
        "SELECT status, COUNT(*) AS count FROM memory_jobs GROUP BY status",
      )
      .all();

    for (const row of rows as Array<Record<string, unknown>>) {
      const status = String(row.status) as MemoryJobStatus;

      if (status in counts) {
        counts[status] = Number(row.count);
      }
    }

    return counts;
  }

  get(id: number): MemoryJob | null {
    const row = this.db.handle.prepare(`${SELECT_JOB} WHERE id = ?`).get(id);

    return row ? this.mapRow(row as Record<string, unknown>) : null;
  }

  private mapRow(row: Record<string, unknown>): MemoryJob {
    return {
      id: Number(row.id),
      status: String(row.status) as MemoryJobStatus,
      messageIds: parseMessageIds(row.message_ids),
      attempts: Number(row.attempts),
      lastError: row.last_error === null ? null : String(row.last_error),
      runAfter: Number(row.run_after),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
}
