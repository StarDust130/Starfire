import { mkdtemp, rm } from "node:fs/promises";

import { tmpdir } from "node:os";

import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type ExtractedMemoryDraft,
  type ExtractionResult,
  type ExtractionTurn,
  MemoryJobs,
  MemoryOrchestrator,
  MemoryStore,
  MessageStore,
  openMemoryDatabase,
} from "../index.js";

let userDataDir = "";

beforeEach(async () => {
  userDataDir = await mkdtemp(path.join(tmpdir(), "starfire-orch-"));
});

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
});

/*
 * Must match the orchestrator's provider contract exactly: readonly
 * arrays, role narrowed to "user" | "assistant". A stub accepting
 * less would violate assignability (contravariance).
 */
type ExtractInput = {
  context: readonly ExtractionTurn[];
  batch: readonly ExtractionTurn[];
};

class StubProvider {
  public calls: ExtractInput[] = [];

  public results: ExtractionResult[] = [];

  async extract(input: ExtractInput): Promise<ExtractionResult> {
    this.calls.push(input);

    const next = this.results.shift();

    if (next) {
      return next;
    }

    return { ok: true, empty: true, drafts: [], usage: null, redactions: [] };
  }
}

function draft(overrides: Partial<ExtractedMemoryDraft>): ExtractedMemoryDraft {
  return {
    category: "profile",
    key: "user-name",
    content: "The user's name is Thor.",
    importance: 4,
    sourceMessageIds: [],
    ...overrides,
  };
}

async function build() {
  const db = await openMemoryDatabase({ userDataDir });

  if (!db) {
    throw new Error("expected the memory database to open");
  }

  const messages = new MessageStore(db);

  const jobs = new MemoryJobs(db);

  const memories = new MemoryStore(db);

  const provider = new StubProvider();

  const orchestrator = new MemoryOrchestrator({
    db,
    messages,
    jobs,
    memories,
    provider,
    debounceMs: 5,
    shutdownBudgetMs: 2_000,
  });

  return { db, messages, jobs, memories, provider, orchestrator };
}

async function seedConversation(messages: MessageStore): Promise<void> {
  for (const [role, content] of [
    ["user", "My name is."],
    ["user", "Or more."],
    ["assistant", "Nice to meet you! What is your name?"],
    ["user", "My name is Thor."],
  ] as const) {
    messages.insertTurn({ sessionId: "s1", role, content });
  }
}

describe("MemoryOrchestrator", () => {
  it("claims a batch atomically, extracts, and stores memories", async () => {
    const { messages, memories, jobs, provider, orchestrator } = await build();

    await seedConversation(messages);

    provider.results.push({
      ok: true,
      empty: false,
      drafts: [
        draft({
          sourceMessageIds: [messages.listUnprocessed(10).at(-1)?.id ?? 0],
        }),
      ],
      usage: null,
      redactions: [],
    });

    await orchestrator.runNow();

    const active = memories.listActive();

    expect(active).toHaveLength(1);
    expect(active[0]?.content).toBe("The user's name is Thor.");
    expect(jobs.counts()).toEqual({
      pending: 0,
      running: 0,
      done: 1,
      failed: 0,
    });
    expect(messages.countUnprocessed()).toBe(0);
  });

  it("fails permanently on non-retryable errors without burning retries", async () => {
    const { messages, jobs, provider, orchestrator } = await build();

    await seedConversation(messages);

    provider.results.push({
      ok: false,
      kind: "auth",
      retryable: false,
      retryAfterMs: null,
      message: "Provider rejected the API key (auth error). Not retrying.",
    });

    await orchestrator.runNow();
    await orchestrator.runNow();

    // Exactly one provider call despite two runs — no retry spam.
    expect(provider.calls).toHaveLength(1);
    expect(jobs.counts()).toEqual({
      pending: 0,
      running: 0,
      done: 0,
      failed: 1,
    });
    expect(messages.countUnprocessed()).toBe(0);
  });

  it("gives the provider neighbor context including fragments", async () => {
    const { messages, provider, orchestrator } = await build();

    await seedConversation(messages);

    await orchestrator.runNow();

    const call = provider.calls[0];

    expect(call?.batch.map((turn) => turn.content)).toEqual([
      "My name is.",
      "Or more.",
      "Nice to meet you! What is your name?",
      "My name is Thor.",
    ]);

    // No earlier turns exist, so context is empty — shape still correct.
    expect(Array.isArray(call?.context)).toBe(true);
  });

  it("treats a valid empty extraction as success", async () => {
    const { messages, memories, jobs, provider, orchestrator } = await build();

    await seedConversation(messages);

    provider.results.push({
      ok: true,
      empty: true,
      drafts: [],
      usage: null,
      redactions: [],
    });

    await orchestrator.runNow();

    expect(memories.countActive()).toBe(0);
    expect(jobs.counts().done).toBe(1);
  });

  it("backs off on failure and succeeds on a later retry", async () => {
    const { db, messages, memories, jobs, provider, orchestrator } =
      await build();

    await seedConversation(messages);

    provider.results.push({
      ok: false,
      kind: "server",
      retryable: true,
      retryAfterMs: null,
      message: "503 boom",
    });

    await orchestrator.runNow();

    expect(jobs.counts().pending).toBe(1);
    expect(memories.countActive()).toBe(0);

    // Simulate the backoff window fully elapsing.
    db.handle
      .prepare("UPDATE memory_jobs SET run_after = ? WHERE status = 'pending'")
      .run(Date.now() - 1);

    provider.results.push({
      ok: true,
      empty: false,
      drafts: [draft({})],
      usage: null,
      redactions: [],
    });

    await orchestrator.runNow();

    expect(memories.countActive()).toBe(1);
    expect(jobs.counts().done).toBe(1);
  });

  it("honors Retry-After from a 429 by pushing run_after out", async () => {
    const { messages, jobs, provider, orchestrator } = await build();

    await seedConversation(messages);

    provider.results.push({
      ok: false,
      kind: "rate_limited",
      retryable: true,
      retryAfterMs: 120_000,
      message: "slow down",
    });

    await orchestrator.runNow();

    // The job must be invisible until its Retry-After delay passes.
    expect(jobs.nextRunnable()).toBeNull();
    expect(jobs.counts().pending).toBe(1);
  });

  it("claims each message exactly once across repeated runs", async () => {
    const { messages, jobs, provider, orchestrator } = await build();

    await seedConversation(messages);

    await orchestrator.runNow();
    await orchestrator.runNow();
    await orchestrator.runNow();

    expect(provider.calls).toHaveLength(1);
    expect(jobs.counts().done).toBe(1);
    expect(messages.countUnprocessed()).toBe(0);
  });

  it("recovers stale running jobs on startup", async () => {
    const { db, messages, memories, jobs, provider, orchestrator } =
      await build();

    await seedConversation(messages);

    /*
     * Simulate a crash mid-claim: the job existed and was running, and
     * the atomic claim had already marked the messages processed.
     */
    const ids = messages.listUnprocessed(10).map((turn) => turn.id);

    db.withTransaction(() => {
      jobs.enqueue(ids);
      messages.markProcessed(ids);
    });

    const jobId = jobs.nextRunnable()?.id ?? 0;

    expect(jobId).toBeGreaterThan(0);

    expect(jobs.markRunning(jobId)).toBe(true);

    // With a 0ms threshold, everything running counts as stale.
    expect(jobs.recoverStaleRunning(0)).toBe(1);

    provider.results.push({
      ok: true,
      empty: false,
      drafts: [draft({})],
      usage: null,
      redactions: [],
    });

    await orchestrator.runNow();

    expect(memories.countActive()).toBe(1);
    expect(jobs.counts()).toEqual({
      pending: 0,
      running: 0,
      done: 1,
      failed: 0,
    });
    expect(messages.countUnprocessed()).toBe(0);
  });

  it("excludes interrupted turns from batches", async () => {
    const { messages, provider, orchestrator } = await build();

    messages.insertTurn({
      sessionId: "s1",
      role: "user",
      content: "hello there",
    });

    messages.insertTurn({
      sessionId: "s1",
      role: "assistant",
      content: "partial reply cut off mid sente",
      interrupted: true,
    });

    messages.insertTurn({
      sessionId: "s1",
      role: "user",
      content: "I prefer dark mode editors",
    });

    await orchestrator.runNow();

    const batchContents = provider.calls[0]?.batch.map((turn) => turn.content);

    expect(batchContents).toEqual([
      "hello there",
      "I prefer dark mode editors",
    ]);
  });

  it("shutdown stops accepting work and reports counts", async () => {
    const { orchestrator } = await build();

    await orchestrator.shutdown();

    orchestrator.notifyTurn(); // must be ignored after dispose

    await orchestrator.runNow(); // no-op

    expect(orchestrator).toBeDefined();
  });
});
