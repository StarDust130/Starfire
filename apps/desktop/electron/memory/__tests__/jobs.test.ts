import { mkdtemp, rm } from "node:fs/promises";

import { tmpdir } from "node:os";

import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EXTRACTION_BATCH_MAX_MESSAGES,
  fitBatch,
  MAX_JOB_ATTEMPTS,
  type MemoryDatabase,
  MemoryJobs,
  MessageStore,
  nextRetryDelayMs,
  openMemoryDatabase,
  RETRY_BASE_MS,
  RETRY_JITTER_MS,
  RETRY_MAX_MS,
} from "../index.js";

let userDataDir = "";

beforeEach(async () => {
  userDataDir = await mkdtemp(path.join(tmpdir(), "starfire-jobs-"));
});

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
});

async function openAll(): Promise<{
  db: MemoryDatabase;
  messages: MessageStore;
  jobs: MemoryJobs;
}> {
  const db = await openMemoryDatabase({ userDataDir });

  if (!db) {
    throw new Error("expected the memory database to open");
  }

  return { db, messages: new MessageStore(db), jobs: new MemoryJobs(db) };
}

function insertTurns(messages: MessageStore, contents: string[]): number[] {
  const ids: number[] = [];

  for (const content of contents) {
    const stored = messages.insertTurn({
      sessionId: "s1",
      role: "user",
      content,
    });

    if (stored) {
      ids.push(stored.id);
    }
  }

  return ids;
}

describe("nextRetryDelayMs", () => {
  it("grows exponentially, caps, and adds bounded jitter", () => {
    expect(nextRetryDelayMs(1, () => 0)).toBe(RETRY_BASE_MS);
    expect(nextRetryDelayMs(2, () => 0)).toBe(RETRY_BASE_MS * 2);
    expect(nextRetryDelayMs(10, () => 0)).toBe(RETRY_MAX_MS);
    expect(nextRetryDelayMs(1, () => 1)).toBe(RETRY_BASE_MS + RETRY_JITTER_MS);
  });
});

describe("MemoryJobs", () => {
  it("enqueues, round-trips, and ignores empty input", async () => {
    const { jobs } = await openAll();

    expect(jobs.enqueue([])).toBeNull();

    const id = jobs.enqueue([3, 1, 2]);

    expect(id).not.toBeNull();

    const job = jobs.get(id as number);

    expect(job?.status).toBe("pending");
    expect(job?.messageIds).toEqual([3, 1, 2]);
    expect(job?.attempts).toBe(0);
    expect(job?.lastError).toBeNull();
  });

  it("failImmediately marks a running job failed in one step", async () => {
    const { jobs } = await openAll();

    const id = jobs.enqueue([1]) as number;

    expect(jobs.markRunning(id)).toBe(true);

    expect(jobs.failImmediately(id, "bad api key")).toBe(true);

    const job = jobs.get(id);

    expect(job?.status).toBe("failed");
    expect(job?.attempts).toBe(1);
    expect(job?.lastError).toBe("bad api key");
    expect(jobs.nextRunnable()).toBeNull();
    expect(jobs.failImmediately(id, "again")).toBe(false);
  });

  it("returns runnable jobs FIFO and respects run_after", async () => {
    const { jobs } = await openAll();

    const first = jobs.enqueue([1]) as number;
    const second = jobs.enqueue([2]) as number;

    expect(jobs.nextRunnable()?.id).toBe(first);

    const now = Date.now();

    expect(jobs.markRunning(first)).toBe(true);
    expect(jobs.complete(first)).toBe(true);

    // Second job is runnable, the completed one is not.
    expect(jobs.nextRunnable()?.id).toBe(second);

    // A future run_after hides a job from nextRunnable.
    const future = jobs.enqueue([3]) as number;

    jobs.fail(future, "not yet", now);
    expect(jobs.nextRunnable(now)?.id).toBe(second);
  });

  it("claims a job exactly once and only completes running jobs", async () => {
    const { jobs } = await openAll();

    const id = jobs.enqueue([1]) as number;

    expect(jobs.markRunning(id)).toBe(true);
    expect(jobs.markRunning(id)).toBe(false);

    expect(jobs.complete(id)).toBe(true);
    expect(jobs.complete(id)).toBe(false);

    expect(jobs.get(id)?.status).toBe("done");
  });

  it("retries with backoff and gives up after the attempt limit", async () => {
    const { jobs } = await openAll();

    const id = jobs.enqueue([1]) as number;

    for (let attempt = 1; attempt < MAX_JOB_ATTEMPTS; attempt += 1) {
      expect(jobs.markRunning(id)).toBe(true);

      const before = Date.now();

      expect(jobs.fail(id, `boom ${attempt}`)).toBe("pending");

      const after = Date.now();

      const job = jobs.get(id);

      expect(job?.status).toBe("pending");
      expect(job?.attempts).toBe(attempt);
      expect(job?.lastError).toBe(`boom ${attempt}`);
      expect(job?.runAfter).toBeGreaterThanOrEqual(before + RETRY_BASE_MS);
      expect(job?.runAfter).toBeLessThanOrEqual(
        after + RETRY_BASE_MS * 2 ** attempt + RETRY_JITTER_MS,
      );
    }

    expect(jobs.markRunning(id)).toBe(true);

    expect(jobs.fail(id, "final blow")).toBe("failed");

    const job = jobs.get(id);

    expect(job?.status).toBe("failed");
    expect(job?.attempts).toBe(MAX_JOB_ATTEMPTS);
    expect(job?.lastError).toBe("final blow");

    // A failed job never runs again.
    expect(jobs.nextRunnable()).toBeNull();
  });

  it("ignores fail() for jobs that are not running", async () => {
    const { jobs } = await openAll();

    const id = jobs.enqueue([1]) as number;

    expect(jobs.fail(id, "too early")).toBe("ignored");

    const job = jobs.get(id);

    expect(job?.status).toBe("pending");
    expect(job?.attempts).toBe(0);
    expect(job?.lastError).toBeNull();
  });

  it("recovers stale running jobs on restart, leaves fresh ones", async () => {
    const { jobs, db } = await openAll();

    const stale = jobs.enqueue([1]) as number;
    const fresh = jobs.enqueue([2]) as number;

    expect(jobs.markRunning(stale)).toBe(true);
    expect(jobs.markRunning(fresh)).toBe(true);

    // Simulate time passing for the stale job only.
    db.handle
      .prepare("UPDATE memory_jobs SET updated_at = ? WHERE id = ?")
      .run(Date.now() - 10 * 60_000, stale);

    expect(jobs.recoverStaleRunning(5 * 60_000)).toBe(1);

    expect(jobs.get(stale)?.status).toBe("pending");
    expect(jobs.get(fresh)?.status).toBe("running");
  });

  it("reports counts by status", async () => {
    const { jobs } = await openAll();

    const doneJob = jobs.enqueue([1]) as number;
    const failedJob = jobs.enqueue([2]) as number;

    expect(jobs.markRunning(doneJob)).toBe(true);
    expect(jobs.complete(doneJob)).toBe(true);

    expect(jobs.markRunning(failedJob)).toBe(true);
    jobs.fail(failedJob, "x");

    expect(jobs.counts()).toEqual({
      pending: 1,
      running: 0,
      done: 1,
      failed: 0,
    });
  });
});

describe("fitBatch", () => {
  it("caps at the message limit and keeps order", () => {
    const turns = Array.from({ length: 45 }, (_, index) => ({
      content: `m${index}`,
    }));

    const batch = fitBatch(turns);

    expect(batch).toHaveLength(EXTRACTION_BATCH_MAX_MESSAGES);
    expect(batch[0]?.content).toBe("m0");
    expect(batch[29]?.content).toBe("m29");
  });

  it("takes fewer messages when content is long", () => {
    const turns = [
      { content: "a".repeat(3_000) },
      { content: "b".repeat(4_000) },
      { content: "c".repeat(4_000) },
    ];

    const batch = fitBatch(turns, 8_000);

    expect(batch).toHaveLength(2);
  });

  it("always includes the first message, even if oversized", () => {
    const batch = fitBatch([{ content: "x".repeat(99_999) }]);

    expect(batch).toHaveLength(1);
  });

  it("returns empty for empty input", () => {
    expect(fitBatch([])).toEqual([]);
  });
});

describe("atomic claim (job + messages commit together)", () => {
  it("rolls back both when the orchestrator crashes mid-claim", async () => {
    const { db, messages, jobs } = await openAll();

    const ids = insertTurns(messages, ["one", "two", "three"]);

    expect(() =>
      db.withTransaction(() => {
        jobs.enqueue(ids);
        messages.markProcessed(ids);
        throw new Error("crash before commit");
      }),
    ).toThrow("crash before commit");

    expect(messages.countUnprocessed()).toBe(3);
    expect(jobs.counts().pending).toBe(0);
  });

  it("commits both together, and a replay finds nothing to claim", async () => {
    const { db, messages, jobs } = await openAll();

    const ids = insertTurns(messages, ["one", "two"]);

    db.withTransaction(() => {
      jobs.enqueue(ids);
      messages.markProcessed(ids);
    });

    expect(messages.countUnprocessed()).toBe(0);

    // Replay-safe: the orchestrator re-running the same tick finds no
    // unprocessed messages, so no duplicate job is possible.
    expect(messages.listUnprocessed(10)).toHaveLength(0);
    expect(jobs.counts().pending).toBe(1);

    const job = jobs.nextRunnable();

    expect(job?.messageIds).toEqual(ids);
  });
});
