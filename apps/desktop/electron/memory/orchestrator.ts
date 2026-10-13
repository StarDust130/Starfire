import type { MemoryDatabase } from "./database.js";

import {
  type ExtractedMemoryDraft,
  type ExtractionResult,
  type ExtractionTurn,
  type GlmExtractionProvider,
  RATE_LIMIT_FALLBACK_MS,
} from "./extraction.js";

import {
  EXTRACTION_BATCH_MAX_CHARS,
  EXTRACTION_BATCH_MAX_MESSAGES,
  fitBatch,
  type MemoryJob,
  type MemoryJobs,
} from "./jobs.js";
import type { MemoryStore } from "./memories.js";
import type { MessageStore } from "./messages.js";

/*
 * The conductor. Owns the whole background pipeline and is the ONLY
 * caller of the provider + MemoryStore. Runs in the trusted main
 * process, one job at a time (single-flight), never on the voice
 * reply path. Triggers:
 *
 *   completed turn ──→ arm idle timer (≈9s, reset per turn) ─┐
 *   ≥30 pending turns ──→ immediate ─────────────────────────┼─→ tick:
 *   session end ──→ short flush ─────────────────────────────┤     claim (atomic)
 *   rate-limit defer ──→ wake timer after cooldown ──────────┘     → extract
 *   startup recover ──→ drain leftovers                            → apply
 *
 * Observability contract: "[Memory] 📝 turn captured" = the
 * conversation is SAVED (durable, survives crashes). "[Memory] ✅
 * extracted job #N" = memories were WRITTEN. Between the two, work is
 * durably queued — never lost, only postponed.
 */

export const CONTEXT_BEFORE_BATCH = 12;

export const TICK_DEBOUNCE_MS = 4_000;

export const IDLE_EXTRACTION_MS = 9_000;

export const SESSION_END_FLUSH_MS = 1_000;

export const SHUTDOWN_FLUSH_BUDGET_MS = 6_000;

export const MAX_DRAIN_JOBS_PER_TICK = 5;

export const DRAIN_CONTINUATION_DELAY_MS = 1_000;

export type MemoryOrchestratorOptions = {
  db: MemoryDatabase;
  messages: MessageStore;
  jobs: MemoryJobs;
  memories: MemoryStore;
  provider: Pick<GlmExtractionProvider, "extract" | "isConfigured">;
  debounceMs?: number;
  idleMs?: number;
  shutdownBudgetMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

function toExtractionTurns(
  turns: readonly {
    id: number;
    role: "user" | "assistant";
    content: string;
  }[],
): ExtractionTurn[] {
  return turns.map((turn) => ({
    id: turn.id,
    role: turn.role,
    content: turn.content,
  }));
}

export class MemoryOrchestrator {
  private readonly debounceMs: number;

  private readonly idleMs: number;

  private readonly shutdownBudgetMs: number;

  private readonly now: () => number;

  private readonly sleep: (ms: number) => Promise<void>;

  private tickTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduledDelayMs = 0;

  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  private running = false;

  private disposed = false;

  /** When set, the drain loop pauses and wakes after the cooldown. */
  private pauseUntil: number | null = null;

  private currentRun: Promise<void> = Promise.resolve();

  constructor(private readonly options: MemoryOrchestratorOptions) {
    this.debounceMs = options.debounceMs ?? TICK_DEBOUNCE_MS;
    this.shutdownBudgetMs =
      options.shutdownBudgetMs ?? SHUTDOWN_FLUSH_BUDGET_MS;
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

    const envIdle = Number(process.env.STARFIRE_MEMORY_IDLE_MS);

    this.idleMs =
      options.idleMs ??
      (Number.isFinite(envIdle) && envIdle > 0 ? envIdle : IDLE_EXTRACTION_MS);
  }

  /**
   * Startup recovery. Starfire holds a single-instance lock, so ANY
   * job left 'running' in the database belongs to a dead process —
   * all of them are recovered IMMEDIATELY (staleness window 0).
   */
  recover(): number {
    const recovered = this.options.jobs.recoverStaleRunning(0);

    if (recovered > 0) {
      console.log(`[Memory] 🔄 recovered ${recovered} interrupted job(s)`);
    }

    if (this.options.provider.isConfigured()) {
      const requeued = this.options.jobs.requeueFailed();

      if (requeued > 0) {
        console.log(`[Memory] ♻️ requeued ${requeued} failed job(s) for retry`);
      }
    }

    this.scheduleTick(DRAIN_CONTINUATION_DELAY_MS);

    return recovered;
  }

  /**
   * Called by the capture hooks after each SAVED turn. Arms (or
   * re-arms) the idle timer so useful facts are extracted after a
   * natural pause WITHOUT ending the conversation — and never for
   * fragments, because only completed turns reach this hook. A full
   * batch still triggers immediately.
   */
  notifyTurn(): void {
    if (this.disposed) {
      return;
    }

    const pending = this.options.messages.countUnprocessed();

    if (pending >= EXTRACTION_BATCH_MAX_MESSAGES) {
      this.clearIdleTimer();

      this.scheduleTick(0);

      return;
    }

    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }

    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;

      this.scheduleTick(0);
    }, this.idleMs);

    this.idleTimer.unref?.();
  }

  /** Called when a voice activation ends (goodbye/idle). */
  notifySessionEnd(): void {
    this.clearIdleTimer();

    this.scheduleTick(SESSION_END_FLUSH_MS);
  }

  /** Test/flush seam: cancels the timer and drains synchronously. */
  async runNow(): Promise<void> {
    this.clearIdleTimer();

    if (this.tickTimer) {
      clearTimeout(this.tickTimer);

      this.tickTimer = null;
    }

    await this.currentRun.catch(() => {});

    await this.tick();
  }

  /**
   * Best-effort bounded flush during app shutdown. The in-flight tick
   * AND the drain loop together can never exceed the budget; unfinished
   * jobs stay recoverable (stale-running recovery / retryable failure).
   */
  async shutdown(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.disposed = true;

    this.clearIdleTimer();

    if (this.tickTimer) {
      clearTimeout(this.tickTimer);

      this.tickTimer = null;
    }

    const deadline = this.now() + this.shutdownBudgetMs;

    await Promise.race([
      this.currentRun.catch(() => {}),
      this.sleep(Math.max(0, deadline - this.now())),
    ]);

    while (this.now() < deadline) {
      const remaining = deadline - this.now();

      const progressed = await Promise.race([
        this.runOne().catch(() => false),
        this.sleep(remaining).then(() => false),
      ]);

      if (!progressed) {
        break;
      }
    }

    const counts = this.options.jobs.counts();

    console.log(
      `[Memory] 🛑 orchestrator stopped ` +
        `(pending=${counts.pending}, failed=${counts.failed})`,
    );
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);

      this.idleTimer = null;
    }
  }

  private scheduleTick(delayMs: number): void {
    if (this.disposed) {
      return;
    }

    if (this.tickTimer) {
      // Keep an already-scheduled earlier tick.
      if (delayMs >= this.scheduledDelayMs) {
        return;
      }

      clearTimeout(this.tickTimer);
    }

    this.scheduledDelayMs = delayMs;

    this.tickTimer = setTimeout(() => {
      this.tickTimer = null;

      this.scheduledDelayMs = 0;

      void this.tick();
    }, delayMs);

    this.tickTimer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.running || this.disposed) {
      return;
    }

    this.running = true;

    const run = (async () => {
      try {
        await this.drain();
      } catch (error) {
        console.error(
          "[Memory] ❌ tick failed:",
          error instanceof Error ? error.message : error,
        );
      } finally {
        this.running = false;
      }
    })();

    this.currentRun = run;

    await run;
  }

  private async drain(): Promise<void> {
    for (let index = 0; index < MAX_DRAIN_JOBS_PER_TICK; index += 1) {
      if (this.disposed) {
        return;
      }

      const progressed = await this.runOne();

      if (!progressed) {
        break;
      }
    }

    if (this.disposed) {
      return;
    }

    // Rate-limited: stop touching the queue and WAKE UP after the
    // cooldown instead of spinning. Earlier (smaller) scheduled ticks
    // still take precedence.
    if (this.pauseUntil !== null) {
      const waitMs = Math.max(0, this.pauseUntil - this.now());

      this.pauseUntil = null;

      this.scheduleTick(waitMs);

      return;
    }

    // Cap reached but work remains — continue shortly.
    if (this.options.jobs.nextRunnable()) {
      this.scheduleTick(DRAIN_CONTINUATION_DELAY_MS);
    }
  }

  /**
   * One unit of work: pick a runnable job (or claim a fresh batch),
   * extract, apply. Returns false when there is nothing to do (or the
   * pipeline paused for a rate-limit cooldown).
   */
  private async runOne(): Promise<boolean> {
    let job: MemoryJob | null = this.options.jobs.nextRunnable(this.now());

    if (!job) {
      if (!this.options.provider.isConfigured()) {
        /*
         * No API key / disabled: do NOT claim new batches. Claiming
         * would mark messages processed and then permanently fail the
         * job — losing them until a manual fix. Leaving them
         * unprocessed means they are extracted automatically once
         * configuration exists.
         */
        return false;
      }

      job = this.claimBatch();

      if (!job) {
        return false;
      }
    }

    if (!this.options.jobs.markRunning(job.id, this.now())) {
      // Another claim won; treat as progress and re-check.
      return true;
    }

    const turns = this.options.messages.getTurnsByIds(job.messageIds);

    if (turns.length === 0) {
      this.options.jobs.complete(job.id, this.now());

      return true;
    }

    const firstId = turns[0]?.id ?? 0;

    const context = this.options.messages.listRecentBefore(
      firstId,
      CONTEXT_BEFORE_BATCH,
    );

    let result: ExtractionResult;

    try {
      result = await this.options.provider.extract({
        context: toExtractionTurns(context),
        batch: toExtractionTurns(turns),
      });
    } catch (error) {
      this.options.jobs.fail(job.id, error, this.now());

      return true;
    }

    if (result.ok) {
      let storedCount = 0;

      let failedCount = 0;

      for (const draft of result.drafts) {
        if (this.applyDraft(draft)) {
          storedCount += 1;
        } else {
          failedCount += 1;
        }
      }

      if (failedCount > 0) {
        /*
         * Extraction succeeded but a database write failed. Completing
         * here would silently lose those memories, so the job stays
         * retryable. recordFact is idempotent — already-stored drafts
         * re-apply as "confirmed" on the retry.
         */
        this.options.jobs.fail(
          job.id,
          new Error(
            `memory write failed for ${failedCount}/${result.drafts.length} draft(s)`,
          ),
          this.now(),
        );

        console.warn(
          `[Memory] ⚠️ job #${job.id} kept retryable: ` +
            `${failedCount} draft write(s) failed (${storedCount} stored)`,
        );

        return true;
      }

      this.options.jobs.complete(job.id, this.now());

      console.log(
        `[Memory] ✅ extracted job #${job.id} ` +
          `(msgs=${turns.length}, memories=${result.drafts.length}` +
          `${result.empty ? ", empty" : ""}${result.ok ? `, model=${result.model}` : ""})`,
      );

      return true;
    }

    // Failure paths — nothing was applied; the job retries or dies.
    if (result.kind === "rate_limited") {
      const delayMs = result.retryAfterMs ?? RATE_LIMIT_FALLBACK_MS;

      this.options.jobs.defer(job.id, delayMs, this.now());

      // Pause the drain and wake after the cooldown — no retry storm.
      this.pauseUntil = this.now() + delayMs;

      console.warn(
        `[Memory] ⏳ job #${job.id} deferred ${Math.round(delayMs / 1000)}s (rate_limited); queue wakes automatically`,
      );

      return false;
    }

    const error = new Error(`${result.kind}: ${result.message}`);

    if (!result.retryable) {
      this.options.jobs.failImmediately(job.id, error, this.now());

      console.error(
        `[Memory] ⛔ job #${job.id} failed permanently (${result.kind}); ` +
          `will be requeued on next start once fixed: ${result.message}`,
      );

      return true;
    }

    this.options.jobs.fail(job.id, error, this.now());

    if (result.retryAfterMs !== null) {
      this.options.jobs.delayJob(job.id, result.retryAfterMs, this.now());
    }

    console.warn(
      `[Memory] ⚠️ job #${job.id} failed (${result.kind}, ` +
        `retryable=${String(result.retryable)}): ${result.message}`,
    );

    return true;
  }

  /**
   * Atomically: create a job for the next fitting batch AND mark those
   * messages processed. A crash mid-way rolls both back (withTransaction).
   */
  private claimBatch(): MemoryJob | null {
    const unprocessed = this.options.messages.listUnprocessed(
      EXTRACTION_BATCH_MAX_MESSAGES,
    );

    if (unprocessed.length === 0) {
      return null;
    }

    const batch = fitBatch(unprocessed, EXTRACTION_BATCH_MAX_CHARS);

    const ids = batch.map((turn) => turn.id);

    const jobId = this.options.db.withTransaction(() => {
      const created = this.options.jobs.enqueue(ids);

      if (created === null) {
        return null;
      }

      this.options.messages.markProcessed(ids);

      return created;
    });

    return jobId === null ? null : this.options.jobs.get(jobId);
  }

  /** Returns true when the draft was durably stored. */
  private applyDraft(draft: ExtractedMemoryDraft): boolean {
    try {
      const result = this.options.memories.recordFact({
        category: draft.category,
        key: draft.key,
        content: draft.content,
        importance: draft.importance,
        sourceMessageIds: draft.sourceMessageIds,
      });

      if (result.ok) {
        console.log(
          `[Memory] 🧠 ${result.action}: ${draft.category}/${draft.key} (chars=${draft.content.length})`,
        );

        return true;
      }

      console.warn(`[Memory] ⚠️ draft rejected: ${result.reason}`);

      return false;
    } catch (error) {
      console.warn(
        "[Memory] ⚠️ draft apply failed:",
        error instanceof Error ? error.message : error,
      );

      return false;
    }
  }
}
