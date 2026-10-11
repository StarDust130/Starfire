import { mkdtemp, rm } from "node:fs/promises";

import { tmpdir } from "node:os";

import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MAX_MEMORY_CHARS,
  MAX_SOURCE_IDS,
  type MemoryCategory,
  type MemoryDatabase,
  MemoryStore,
  normalizeKey,
  openMemoryDatabase,
  type RecordFactResult,
} from "../index.js";

let userDataDir = "";

beforeEach(async () => {
  userDataDir = await mkdtemp(path.join(tmpdir(), "starfire-memories-"));
});

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
});

async function openStore(): Promise<{
  db: MemoryDatabase;
  store: MemoryStore;
}> {
  const db = await openMemoryDatabase({ userDataDir });

  if (!db) {
    throw new Error("expected the memory database to open");
  }

  return { db, store: new MemoryStore(db) };
}

function expectOk(
  result: RecordFactResult,
): Extract<RecordFactResult, { ok: true }> {
  if (!result.ok) {
    throw new Error(`expected recordFact to succeed: ${result.reason}`);
  }

  return result;
}

describe("normalizeKey", () => {
  it("normalizes messy keys", () => {
    expect(normalizeKey("  MY  Favorite.color!! ")).toBe("my-favorite.color");
    expect(normalizeKey("///")).toBe("");
  });
});

describe("MemoryStore.recordFact", () => {
  it("inserts a new fact as active with normalized key and provenance", async () => {
    const { store } = await openStore();

    const result = expectOk(
      store.recordFact({
        category: "profile",
        key: "  User  Name ",
        content: "  The user's name is Thor.  ",
        importance: 4,
        sourceMessageIds: [7],
      }),
    );

    expect(result.action).toBe("inserted");
    expect(result.memory.key).toBe("user-name");
    expect(result.memory.content).toBe("The user's name is Thor.");
    expect(result.memory.state).toBe("active");
    expect(result.memory.importance).toBe(4);
    expect(result.memory.sourceMessageIds).toEqual([7]);

    expect(store.countActive()).toBe(1);
  });

  it("rejects empty keys, empty content, and invalid categories", async () => {
    const { store } = await openStore();

    expect(
      store.recordFact({ category: "fact", key: "!!!", content: "x" }).ok,
    ).toBe(false);

    expect(
      store.recordFact({ category: "fact", key: "k", content: "   " }).ok,
    ).toBe(false);

    expect(
      store.recordFact({
        category: "junk" as MemoryCategory,
        key: "k",
        content: "x",
      }).ok,
    ).toBe(false);
  });

  it("confirms an unchanged fact, merges provenance, raises importance", async () => {
    const { store } = await openStore();

    const first = expectOk(
      store.recordFact({
        category: "preference",
        key: "editor",
        content: "Uses VS Code.",
        importance: 2,
        sourceMessageIds: [1],
      }),
    );

    expect(first.memory.lastConfirmedAt).toBeNull();

    const second = expectOk(
      store.recordFact({
        category: "preference",
        key: "editor",
        content: "Uses VS Code.",
        importance: 5,
        sourceMessageIds: [2, 1],
      }),
    );

    expect(second.action).toBe("confirmed");
    expect(second.memory.id).toBe(first.memory.id);
    expect(second.memory.importance).toBe(5);
    expect(second.memory.sourceMessageIds).toEqual([1, 2]);
    expect(second.memory.lastConfirmedAt).not.toBeNull();

    expect(store.countActive()).toBe(1);
  });

  it("supersedes a changed fact and keeps exactly one active row", async () => {
    const { store, db } = await openStore();

    const first = expectOk(
      store.recordFact({
        category: "profile",
        key: "user-name",
        content: "The user's name is Mor.",
        sourceMessageIds: [3],
      }),
    );

    const second = expectOk(
      store.recordFact({
        category: "profile",
        key: "user-name",
        content: "The user's name is Thor.",
        sourceMessageIds: [7],
      }),
    );

    expect(second.action).toBe("superseded");
    expect(second.memory.id).not.toBe(first.memory.id);

    const active = store.findActive("profile", "user-name");

    expect(active?.content).toBe("The user's name is Thor.");

    const history = store.listHistory("profile", "user-name");

    expect(history).toHaveLength(2);
    expect(history.find((memory) => memory.id === first.memory.id)?.state).toBe(
      "superseded",
    );

    const superseded = db.handle
      .prepare(
        "SELECT COUNT(*) AS count FROM memories WHERE state = 'superseded'",
      )
      .get();

    expect(Number(superseded?.count)).toBe(1);
    expect(store.countActive()).toBe(1);
  });

  // NEW TEST: case and punctuation variants confirm the existing fact.
  it("confirms case/punctuation variants of the same fact", async () => {
    const { store } = await openStore();

    const first = expectOk(
      store.recordFact({
        category: "profile",
        key: "user-name",
        content: "The user's name is Thor.",
      }),
    );

    const second = expectOk(
      store.recordFact({
        category: "profile",
        key: "user-name",
        content: "the users name is THOR",
      }),
    );

    expect(second.action).toBe("confirmed");
    expect(second.memory.id).toBe(first.memory.id);
    expect(second.memory.content).toBe("the users name is THOR");
    expect(store.countActive()).toBe(1);
  });

  it("enforces one active row per key even against raw inserts", async () => {
    const { store, db } = await openStore();

    expectOk(store.recordFact({ category: "fact", key: "k", content: "one" }));

    const now = Date.now();

    expect(() =>
      db.handle
        .prepare(
          "INSERT INTO memories (category, key, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("fact", "k", "two", now, now),
    ).toThrow(/UNIQUE/i);

    expect(store.countActive()).toBe(1);
  });

  it("hides non-active rows from findActive and listActive", async () => {
    const { store } = await openStore();

    expectOk(
      store.recordFact({
        category: "goal",
        key: "career",
        content: "Become an AI engineer.",
        importance: 5,
      }),
    );

    const editor = expectOk(
      store.recordFact({
        category: "fact",
        key: "editor",
        content: "Uses VS Code.",
        importance: 5,
      }),
    );

    // Confirming freshens updated_at -> same importance, listed first.
    expectOk(
      store.recordFact({
        category: "fact",
        key: "editor",
        content: "Uses VS Code.",
      }),
    );

    expect(store.listActive().map((memory) => memory.key)).toEqual([
      "editor",
      "career",
    ]);

    expect(store.archive(editor.memory.id)).toBe(true);

    expect(store.findActive("fact", "editor")).toBeNull();
    expect(store.listActive().map((memory) => memory.key)).toEqual(["career"]);
    expect(store.countActive()).toBe(1);
    expect(store.archive(editor.memory.id)).toBe(false);
  });

  it("forget removes a memory completely, including history", async () => {
    const { store } = await openStore();

    const fact = expectOk(
      store.recordFact({
        category: "event",
        key: "launch-day",
        content: "Shipped v1 on Friday.",
      }),
    );

    expect(store.forget(fact.memory.id)).toBe(true);
    expect(store.findActive("event", "launch-day")).toBeNull();
    expect(store.listHistory("event", "launch-day")).toEqual([]);
    expect(store.countActive()).toBe(0);
    expect(store.forget(fact.memory.id)).toBe(false);
  });

  it("clamps importance into the 1..5 range", async () => {
    const { store } = await openStore();

    const high = expectOk(
      store.recordFact({
        category: "fact",
        key: "high",
        content: "h",
        importance: 99,
      }),
    );

    const low = expectOk(
      store.recordFact({
        category: "fact",
        key: "low",
        content: "l",
        importance: 0,
      }),
    );

    expect(high.memory.importance).toBe(5);
    expect(low.memory.importance).toBe(1);
  });

  it("caps content length and sanitizes source message ids", async () => {
    const { store } = await openStore();

    const result = expectOk(
      store.recordFact({
        category: "fact",
        key: "long",
        content: "x".repeat(MAX_MEMORY_CHARS + 500),
        sourceMessageIds: [
          -3,
          2.5,
          ...Array.from({ length: MAX_SOURCE_IDS + 10 }, (_, i) => i + 1),
        ],
      }),
    );

    expect(result.memory.content).toHaveLength(MAX_MEMORY_CHARS);
    expect(result.memory.sourceMessageIds).toHaveLength(MAX_SOURCE_IDS);
    expect(result.memory.sourceMessageIds).not.toContain(-3);
    expect(result.memory.sourceMessageIds).toContain(1);
  });
});
