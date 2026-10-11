import { mkdtemp, rm } from "node:fs/promises";

import { tmpdir } from "node:os";

import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatRelevantContext } from "../context.js";
import {
  CONTEXT_MAX_CHARS,
  ContextBuilder,
  type MemoryDatabase,
  MemorySearch,
  MemoryStore,
  MessageStore,
  openMemoryDatabase,
} from "../index.js";

let userDataDir = "";

beforeEach(async () => {
  userDataDir = await mkdtemp(path.join(tmpdir(), "starfire-context-"));
});

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
});

async function build(): Promise<{
  db: MemoryDatabase;
  memories: MemoryStore;
  messages: MessageStore;
  context: ContextBuilder;
}> {
  const db = await openMemoryDatabase({ userDataDir });

  if (!db) {
    throw new Error("expected the memory database to open");
  }

  const memories = new MemoryStore(db);

  const messages = new MessageStore(db);

  const search = new MemorySearch(db);

  return {
    db,
    memories,
    messages,
    context: new ContextBuilder(memories, search),
  };
}

describe("ContextBuilder", () => {
  it("returns empty for a query with nothing searchable", async () => {
    const { context } = await build();

    expect(context.build("")).toBe("");
    expect(context.build("what about that???")).toBe("");
  });

  it("never repeats facts Core Memory already carries", async () => {
    const { memories, context } = await build();

    memories.recordFact({
      category: "profile",
      key: "user.name",
      content: "The user's name is Thor.",
      importance: 5,
    });

    memories.recordFact({
      category: "fact",
      key: "hobby.cliffs",
      content: "Thor likes high cliffs.",
      importance: 2,
    });

    // Few memories -> every active row is part of Core Memory, so the
    // builder must add nothing.
    expect(context.build("thor")).toBe("");
  });

  it("adds facts that sit beyond the Core Memory set", async () => {
    const { memories, context } = await build();

    // Fill Core Memory (top 20 active rows) with importance-5 facts;
    // one of them mentions zeta so it becomes a matching, core-owned hit.
    for (let index = 0; index < 20; index += 1) {
      memories.recordFact({
        category: "fact",
        key: `alpha.${index}`,
        content:
          index === 0
            ? "Alpha zeta keeper zero."
            : `Alpha keeper fact number ${index}.`,
        importance: 5,
      });
    }

    memories.recordFact({
      category: "fact",
      key: "zeta.side",
      content: "Zeta side note worth surfacing.",
      importance: 1,
    });

    const block = context.build("zeta");

    expect(block).toContain("Zeta side note worth surfacing.");
    expect(block).not.toContain("Alpha zeta keeper");
  });

  it("excludes live-conversation message ids", async () => {
    const { messages, context } = await build();

    const first = messages.insertTurn({
      sessionId: "s1",
      role: "user",
      content: "we planned the kyoto trip for spring",
    });

    const second = messages.insertTurn({
      sessionId: "s2",
      role: "user",
      content: "kyoto photos turned out great",
    });

    const block = context.build("kyoto", {
      excludeMessageIds: new Set([first?.id ?? 0]),
    });

    expect(block).toContain(
      second?.id ? "photos turned out great" : "impossible",
    );
    expect(block).not.toContain("planned the kyoto trip");
  });

  it("redacts secrets from past chats inside the block", async () => {
    const { messages, context } = await build();

    messages.insertTurn({
      sessionId: "s1",
      role: "user",
      content: "we planned the launch, my password is hunter2 anyway",
    });

    const block = context.build("launch");

    expect(block).not.toContain("hunter2");
    expect(block).toContain("[REDACTED");
  });

  it("enforces the strict context size limit", async () => {
    const { messages, context } = await build();

    for (let index = 0; index < 30; index += 1) {
      messages.insertTurn({
        sessionId: "s1",
        role: "user",
        content: `meeting ${index}: ${"detail ".repeat(12)}trimmed`,
      });
    }

    const block = context.build("meeting");

    expect(block.length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS);
    expect(block).toContain("meeting 29:");
    expect(block).toContain("From past chats:");
  });

  it("builds fast on a few hundred rows", async () => {
    const { memories, messages, context } = await build();

    for (let index = 0; index < 30; index += 1) {
      memories.recordFact({
        category: "fact",
        key: `bulk.item.${index}`,
        content: `Bulk memory entry number ${index} about topic-${index % 7}.`,
        importance: index >= 20 ? 1 : 3,
      });
    }

    for (let index = 0; index < 200; index += 1) {
      messages.insertTurn({
        sessionId: "perf",
        role: "user",
        content: `perf message ${index} mentions topic-${index % 7} inline`,
      });
    }

    const startedAt = Date.now();

    const block = context.build("topic");

    const elapsed = Date.now() - startedAt;

    expect(block).toContain("Bulk memory entry");
    expect(block).toContain("From past chats:");
    expect(elapsed).toBeLessThan(2_000);
  });

  it("degrades to empty when the database fails", async () => {
    const { db, memories, context } = await build();

    memories.recordFact({
      category: "fact",
      key: "note.a",
      content: "Some stored fact aboutTopic.",
      importance: 1,
    });

    for (let index = 0; index < 20; index += 1) {
      memories.recordFact({
        category: "fact",
        key: `filler.${index}`,
        content: `Filler fact number ${index}.`,
        importance: 5,
      });
    }

    db.close();

    expect(context.build("topic")).toBe("");
  });
});

describe("formatRelevantContext", () => {
  it("returns empty for nothing selected", () => {
    expect(formatRelevantContext({ memories: [], messages: [] })).toBe("");
  });

  it("returns empty when nothing fits the budget", () => {
    const block = formatRelevantContext({
      memories: [
        {
          id: 1,
          category: "fact",
          key: "big",
          content: "x".repeat(2_000),
          importance: 1,
          updatedAt: 1,
        },
      ],
      messages: [],
    });

    expect(block).toBe("");
  });
});
