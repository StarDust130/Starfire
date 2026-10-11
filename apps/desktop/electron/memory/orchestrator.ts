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
 * process, one job at a time, never on the voice reply path:
 *
 *   new turn ──→ debounce ──┐
 *   ≥30 pending ────────────┼─→ tick: claim batch (atomic) → extract
 *   session end ────────────┤        → apply drafts via recordFact
 *   startup recover ────────┘        → complete / backoff
 *
 * All triggers funnel into scheduleTick(); a single `running` flag
 * guarantees one drain at a time (single-flight).
 */

export const CONTEXT_BEFORE_BATCH = 12;

export const TICK_DEBOUNCE_MS = 4_000;

export const SESSION_END_FLUSH_MS = 1_000;

export const SHUTDOWN_FLUSH_BUDGET_MS = 6_000;

export const MAX_DRAIN_JOBS_PER_TICK = 5;

export const DRAIN_CONTINUATION_DELAY_MS = 1_000;

export type MemoryOrchestratorOptions = {
  db: MemoryDatabase;
  messages: MessageStore;
  jobs: MemoryJobs;
  memories: MemoryStore;
  provider: Pick<GlmExtractionProvider, "extract">;
  debounceMs?: number;
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

  private readonly shutdownBudgetMs: number;

  private readonly now: () => number;

  private readonly sleep: (ms: number) => Promise<void>;

  private tickTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduledDelayMs = 0;

  private running = false;

  private disposed = false;

  private currentRun: Promise<void> = Promise.resolve();

  constructor(private readonly options: MemoryOrchestratorOptions) {
    this.debounceMs = options.debounceMs ?? TICK_DEBOUNCE_MS;
    this.shutdownBudgetMs =
      options.shutdownBudgetMs ?? SHUTDOWN_FLUSH_BUDGET_MS;
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Startup: reset jobs orphaned by a crash, then drain leftovers. */
  recover(): number {
    const recovered = this.options.jobs.recoverStaleRunning();

    if (recovered > 0) {
      console.log(`[Memory] 🔄 recovered ${recovered} interrupted job(s)`);
    }

    this.scheduleTick(DRAIN_CONTINUATION_DELAY_MS);

    return recovered;
  }

  /** Called by the capture hooks after each stored turn. */
  notifyTurn(): void {
    /*
     * NO mid-conversation extraction: it fires constantly while the
     * user is still talking — it churns the shared rate limit, and
     * fragments get extracted before their context completes (that is
     * where garbage rows came from). Extraction triggers are now:
     * session end, shutdown flush, startup recovery, and a full
     * pending batch.
     */
    const pending = this.options.messages.countUnprocessed();

    if (pending >= EXTRACTION_BATCH_MAX_MESSAGES) {
      this.scheduleTick(0);
    }
  }

  /** Called when a voice activation ends (goodbye/idle). */
  notifySessionEnd(): void {
    this.scheduleTick(SESSION_END_FLUSH_MS);
  }

  /** Test/flush seam: cancels the timer and drains synchronously. */
  async runNow(): Promise<void> {
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);

      this.tickTimer = null;
    }

    await this.currentRun.catch(() => {});

    await this.tick();
  }

  /** Best-effort bounded flush during app shutdown. */
  async shutdown(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.disposed = true;

    if (this.tickTimer) {
      clearTimeout(this.tickTimer);

      this.tickTimer = null;
    }

    await this.currentRun.catch(() => {});

    const startedAt = this.now();

    while (this.now() - startedAt < this.shutdownBudgetMs) {
      const progressed = await this.runOne();

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
        return;
      }
    }

    // Cap reached but work remains — continue shortly.
    if (this.options.jobs.nextRunnable()) {
      this.scheduleTick(DRAIN_CONTINUATION_DELAY_MS);
    }
  }

  /**
   * One unit of work: pick a runnable job (or claim a fresh batch),
   * extract, apply. Returns false when there is nothing to do.
   */
  private async runOne(): Promise<boolean> {
    let job: MemoryJob | null = this.options.jobs.nextRunnable(this.now());

    if (!job) {
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
      // Job references nothing durable — just finish it.
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
      for (const draft of result.drafts) {
        this.applyDraft(draft);
      }

      this.options.jobs.complete(job.id, this.now());

      console.log(
        `[Memory] ✅ job #${job.id} done ` +
          `(msgs=${turns.length}, memories=${result.drafts.length}` +
          `${result.empty ? ", empty" : ""})`,
      );

      return true;
    }

    // Rate limits defer the job without consuming a retry attempt.
    if (result.kind === "rate_limited") {
      const delayMs = result.retryAfterMs ?? RATE_LIMIT_FALLBACK_MS;

      this.options.jobs.defer(job.id, delayMs, this.now());

      console.warn(
        `[Memory] ⏳ job #${job.id} deferred ` +
          `${Math.round(delayMs / 1000)}s (rate_limited)`,
      );

      return true;
    }

    const error = new Error(`${result.kind}: ${result.message}`);

    // Permanent errors cannot succeed through retries.
    if (!result.retryable) {
      this.options.jobs.failImmediately(job.id, error, this.now());

      console.error(
        `[Memory] ⛔ job #${job.id} failed permanently (${result.kind}); ` +
          `fix configuration to re-extract later: ${result.message}`,
      );

      return true;
    }

    // Retryable errors follow the existing retry policy.
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

  private applyDraft(draft: ExtractedMemoryDraft): void {
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
          `[Memory] 🧠 ${result.action}: ${draft.category}/${draft.key} — ${draft.content}`,
        );
      } else {
        console.warn(`[Memory] ⚠️ draft rejected: ${result.reason}`);
      }
    } catch (error) {
      console.warn(
        "[Memory] ⚠️ draft apply failed:",
        error instanceof Error ? error.message : error,
      );
    }
  }
}
