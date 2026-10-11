import { mkdtemp, rm } from "node:fs/promises";

import { tmpdir } from "node:os";

import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type MemoryDatabase,
  MemorySearch,
  MemoryStore,
  MessageStore,
  normalizeSearchQuery,
  openMemoryDatabase,
  SEARCH_MAX_TOKENS,
} from "../index.js";

let userDataDir = "";

beforeEach(async () => {
  userDataDir = await mkdtemp(path.join(tmpdir(), "starfire-search-"));
});

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
});

async function build(): Promise<{
  db: MemoryDatabase;
  memories: MemoryStore;
  messages: MessageStore;
  search: MemorySearch;
}> {
  const db = await openMemoryDatabase({ userDataDir });

  if (!db) {
    throw new Error("expected the memory database to open");
  }

  return {
    db,
    memories: new MemoryStore(db),
    messages: new MessageStore(db),
    search: new MemorySearch(db),
  };
}

describe("normalizeSearchQuery", () => {
  it("lowercases, strips punctuation, and drops stopwords", () => {
    expect(
      normalizeSearchQuery("What did I say about my Meeting on Friday?"),
    ).toEqual(["meeting", "friday"]);
  });

  it("returns empty for empty, whitespace, or stopword-only queries", () => {
    expect(normalizeSearchQuery("")).toEqual([]);
    expect(normalizeSearchQuery("   ")).toEqual([]);
    expect(normalizeSearchQuery("what did i say to you about that?")).toEqual(
      [],
    );
  });

  it("deduplicates and caps the token count", () => {
    const many = Array.from({ length: 12 }, (_, index) => `word${index}`);

    const tokens = normalizeSearchQuery(many.join(" "));

    expect(tokens).toHaveLength(SEARCH_MAX_TOKENS);
    expect(normalizeSearchQuery("apple apple APPLE")).toEqual(["apple"]);
  });
});

describe("MemorySearch — memories", () => {
  it("finds by content and ranks by importance", async () => {
    const { memories, search } = await build();

    memories.recordFact({
      category: "fact",
      key: "editor",
      content: "Uses VS Code daily for work.",
      importance: 2,
    });

    memories.recordFact({
      category: "profile",
      key: "user.name",
      content: "The user's name is Thor.",
      importance: 5,
    });

    const hits = search.searchMemories("name");

    expect(hits).toHaveLength(1);
    expect(hits[0]?.key).toBe("user.name");
    expect(hits[0]?.content).toContain("Thor");
  });

  it("returns ONLY active memories — superseded and archived invisible", async () => {
    const { memories, search } = await build();

    memories.recordFact({
      category: "project",
      key: "app.language",
      content: "The app project uses rust.",
      importance: 3,
    });

    memories.recordFact({
      category: "project",
      key: "app.language",
      content: "The app project uses golang.",
      importance: 3,
    });

    expect(search.searchMemories("rust")).toEqual([]);
    expect(search.searchMemories("golang")).toHaveLength(1);
  });

  it("requires EVERY token to match (AND semantics)", async () => {
    const { memories, search } = await build();

    memories.recordFact({
      category: "fact",
      key: "hobby.a",
      content: "Thor builds rocket models on weekends.",
    });

    memories.recordFact({
      category: "fact",
      key: "hobby.b",
      content: "Thor drinks tea every morning.",
    });

    expect(search.searchMemories("thor rocket")).toHaveLength(1);
    expect(search.searchMemories("thor tea")).toHaveLength(1);
    expect(search.searchMemories("rocket tea")).toEqual([]);
  });

  it("matches the key even when content lacks the word", async () => {
    const { memories, search } = await build();

    memories.recordFact({
      category: "preference",
      key: "favorite-editor",
      content: "Uses VS Code.",
    });

    const hits = search.searchMemories("editor");

    expect(hits).toHaveLength(1);
    expect(hits[0]?.key).toBe("favorite-editor");
  });

  it("respects the limit", async () => {
    const { memories, search } = await build();

    for (let index = 0; index < 8; index += 1) {
      memories.recordFact({
        category: "fact",
        key: `song.${index}`,
        content: `Favorite song number ${index} is loud.`,
      });
    }

    expect(search.searchMemories("song")).toHaveLength(5);
    expect(search.searchMemories("song", 3)).toHaveLength(3);
    expect(search.searchMemories("song", 99)).toHaveLength(8);
  });

  it("treats wildcard-looking queries as plain tokens, never match-all", async () => {
    const { memories, search } = await build();

    memories.recordFact({
      category: "fact",
      key: "note.a",
      content: "Some ordinary stored fact.",
    });

    expect(search.searchMemories("%")).toEqual([]);
    expect(search.searchMemories("100%")).toEqual([]);
    expect(search.searchMemories("a_b_c")).toEqual([]);
    expect(search.searchMemories("ordinary")).toHaveLength(1);
  });
});

describe("MemorySearch — memory privacy & exclusions", () => {
  it("REDACTS secret-shaped content in memory hits (legacy row protection)", async () => {
    const { db, search } = await build();

    const now = Date.now();

    db.handle
      .prepare(
        "INSERT INTO memories (category, key, content, importance, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
      )
      .run(
        "fact",
        "legacy.token",
        "saved token sk-abcdefghijklmnopqrstuvwx ok",
        3,
        now,
        now,
      );

    const hits = search.searchMemories("token");

    expect(hits).toHaveLength(1);
    expect(hits[0]?.content).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(hits[0]?.content).toContain("[REDACTED");
  });

  it("excludeMemoryIds hides exactly those rows", async () => {
    const { memories, search } = await build();

    const a = memories.recordFact({
      category: "fact",
      key: "pick.a",
      content: "Alpha fact worth finding.",
    });

    const b = memories.recordFact({
      category: "fact",
      key: "pick.b",
      content: "Beta fact worth finding.",
    });

    const withExclusion = search.search("worth finding", {
      excludeMemoryIds: new Set([a.memory.id]),
    });

    expect(withExclusion.memories.map((hit) => hit.id)).toEqual([b.memory.id]);

    const without = search.search("worth finding");

    expect(without.memories).toHaveLength(2);
  });

  it("excludeSessionIds hides whole message sessions", async () => {
    const { messages, search } = await build();

    messages.insertTurn({
      sessionId: "live",
      role: "user",
      content: "secret plan for kyoto",
    });

    messages.insertTurn({
      sessionId: "old",
      role: "user",
      content: "older kyoto notes",
    });

    const result = search.search("kyoto", {
      excludeSessionIds: new Set(["live"]),
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.sessionId).toBe("old");
  });
});

describe("MemorySearch — messages", () => {
  it("finds by token, orders newest first, excludes interrupted", async () => {
    const { messages, search } = await build();

    const first = messages.insertTurn({
      sessionId: "s1",
      role: "user",
      content: "We planned the kyoto trip in detail.",
    });

    messages.insertTurn({
      sessionId: "s1",
      role: "assistant",
      content: "kyoto partial reply cut off mid sentence",
      interrupted: true,
    });

    const last = messages.insertTurn({
      sessionId: "s2",
      role: "user",
      content: "The kyoto photos were amazing.",
    });

    const hits = search.searchMessages("kyoto");

    expect(hits.map((hit) => hit.id)).toEqual([last?.id, first?.id]);
  });

  it("REDACTS secrets before returning message content", async () => {
    const { messages, search } = await build();

    messages.insertTurn({
      sessionId: "s1",
      role: "user",
      content: "we planned the launch, my password is hunter2 anyway",
    });

    const hits = search.searchMessages("launch");

    expect(hits).toHaveLength(1);

    const content = hits[0]?.content ?? "";

    expect(content).not.toContain("hunter2");
    expect(content).toContain("[REDACTED");
  });

  it("snippet-caps long message content around the match", async () => {
    const { messages, search } = await build();

    const filler =
      "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod ";

    messages.insertTurn({
      sessionId: "s1",
      role: "user",
      content: `${filler.repeat(8)}needle${filler.repeat(8)}`,
    });

    const hits = search.searchMessages("needle");

    expect(hits).toHaveLength(1);

    const content = hits[0]?.content ?? "";

    expect(content).toContain("needle");
    expect(content.length).toBeLessThanOrEqual(302);
    expect(content.startsWith("…")).toBe(true);
  });

  it("matches unicode content", async () => {
    const { messages, search } = await build();

    messages.insertTurn({
      sessionId: "s1",
      role: "user",
      content: "我喜欢喝茶 also coffee sometimes",
    });

    const hits = search.searchMessages("喝茶");

    expect(hits).toHaveLength(1);
    expect(hits[0]?.content).toContain("我喜欢喝茶");
  });
});

describe("MemorySearch — combined search", () => {
  it("returns both sources and empty for nothing-searchable", async () => {
    const { memories, messages, search } = await build();

    expect(search.search("")).toEqual({
      query: "",
      tokens: [],
      memories: [],
      messages: [],
    });

    memories.recordFact({
      category: "goal",
      key: "goal.career",
      content: "Wants to become an AI engineer.",
      importance: 5,
    });

    messages.insertTurn({
      sessionId: "s1",
      role: "user",
      content: "I want to become an AI engineer someday.",
    });

    const result = search.search("become an engineer");

    expect(result.tokens).toEqual(["become", "engineer"]);
    expect(result.memories).toHaveLength(1);
    expect(result.messages).toHaveLength(1);
  });

  it("stays fast and correct on a few hundred rows", async () => {
    const { memories, messages, search } = await build();

    for (let index = 0; index < 30; index += 1) {
      memories.recordFact({
        category: "fact",
        key: `bulk.item.${index}`,
        content: `Bulk memory entry number ${index} about topic-${index % 7}.`,
      });
    }

    for (let index = 0; index < 200; index += 1) {
      messages.insertTurn({
        sessionId: "perf",
        role: "user",
        content: `bulk perf message ${index} mentions topic-${index % 7} inline`,
      });
    }

    const startedAt = Date.now();

    const result = search.search("bulk topic");

    const elapsed = Date.now() - startedAt;

    expect(result.memories).toHaveLength(5);
    expect(result.messages).toHaveLength(5);
    expect(elapsed).toBeLessThan(2_000);
  });
});
