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

type ExtractInput = {
  context: readonly ExtractionTurn[];
  batch: readonly ExtractionTurn[];
};

class StubProvider {
  public calls: ExtractInput[] = [];

  public results: ExtractionResult[] = [];

  public configured = true;

  isConfigured(): boolean {
    return this.configured;
  }

  async extract(input: ExtractInput): Promise<ExtractionResult> {
    this.calls.push(input);

    const next = this.results.shift();

    if (next) {
      return next;
    }

    return { ok: true, empty: true, drafts: [], usage: null, redactions: [] };
  }
}

/*
 * A MemoryStore whose writes always fail. Sabotages ONLY the memory
 * write path — the provider and job bookkeeping keep running against
 * the real database. This isolates the guarantee under test: a failed
 * write keeps the job retryable instead of silently losing memories.
 */
class FailingMemoryStore extends MemoryStore {
  public attempts = 0;

  recordFact(): never {
    this.attempts += 1;

    throw new Error("database is not open (simulated write failure)");
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

  it("keeps the job retryable when a memory write fails", async () => {
    const { db, messages, jobs, provider } = await build();

    await seedConversation(messages);

    provider.results.push({
      ok: true,
      empty: false,
      drafts: [draft({})],
      usage: null,
      redactions: [],
    });

    /*
     * Sabotage ONLY the memory-write path. Provider and job
     * bookkeeping keep running against the real database, so the
     * failure is scoped exactly to where it matters.
     */
    const sabotaged = new MemoryOrchestrator({
      db,
      messages,
      jobs,
      memories: new FailingMemoryStore(db),
      provider,
      debounceMs: 5,
      shutdownBudgetMs: 2_000,
    });

    await sabotaged.runNow();

    expect(provider.calls).toHaveLength(1);

    /*
     * Extraction succeeded but the write failed: the job must be
     * PENDING again (retryable with backoff) — never "done", which
     * would silently lose the memory. A later retry re-applies the
     * same drafts safely (recordFact is idempotent).
     */
    expect(jobs.counts()).toEqual({
      pending: 1,
      running: 0,
      done: 0,
      failed: 0,
    });

    const job = jobs.get(1);

    expect(job?.status).toBe("pending");
    expect(job?.attempts).toBe(1);
    expect(job?.lastError).toContain("memory write failed");
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

    const ids = messages.listUnprocessed(10).map((turn) => turn.id);

    db.withTransaction(() => {
      jobs.enqueue(ids);
      messages.markProcessed(ids);
    });

    const jobId = jobs.nextRunnable()?.id ?? 0;

    expect(jobId).toBeGreaterThan(0);

    expect(jobs.markRunning(jobId)).toBe(true);

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

  it("does not claim batches while the provider is unconfigured", async () => {
    const { messages, jobs, provider, orchestrator } = await build();

    provider.configured = false;

    await seedConversation(messages);

    await orchestrator.runNow();
    await orchestrator.runNow();

    expect(provider.calls).toHaveLength(0);
    expect(jobs.counts().pending).toBe(0);
    expect(jobs.counts().failed).toBe(0);

    // Messages stay unprocessed — extractable later, never lost.
    expect(messages.countUnprocessed()).toBe(4);

    provider.configured = true; // the key was added

    await orchestrator.runNow();

    expect(provider.calls).toHaveLength(1);
    expect(messages.countUnprocessed()).toBe(0);
    expect(jobs.counts().done).toBe(1);
  });

  it("requeues permanently failed jobs on startup when configured", async () => {
    const { messages, memories, jobs, provider, orchestrator } = await build();

    await seedConversation(messages);

    provider.results.push({
      ok: false,
      kind: "auth",
      retryable: false,
      retryAfterMs: null,
      message: "Provider rejected the API key (auth error). Not retrying.",
    });

    await orchestrator.runNow();

    expect(jobs.counts().failed).toBe(1);
    expect(provider.calls).toHaveLength(1);

    // "Fixed the key, restarted the app."
    provider.results.push({
      ok: true,
      empty: false,
      drafts: [draft({})],
      usage: null,
      redactions: [],
    });

    orchestrator.recover();

    await orchestrator.runNow();

    expect(memories.countActive()).toBe(1);
    expect(jobs.counts()).toEqual({
      pending: 0,
      running: 0,
      done: 1,
      failed: 0,
    });
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

    expect(provider.calls).toHaveLength(1);
    expect(jobs.counts()).toEqual({
      pending: 0,
      running: 0,
      done: 0,
      failed: 1,
    });
    expect(messages.countUnprocessed()).toBe(0);
  });
});
