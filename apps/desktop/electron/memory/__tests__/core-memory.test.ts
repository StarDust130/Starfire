import { mkdtemp, rm } from "node:fs/promises";

import { tmpdir } from "node:os";

import path from "node:path";

import { describe, expect, it } from "vitest";
import { formatCoreMemory, selectCoreMemory } from "../core-memory.js";
import {
  CORE_MEMORY_MAX_CHARS,
  CoreMemoryProvider,
  MemoryStore,
  openMemoryDatabase,
  type RecordFactResult,
  type StoredMemory,
} from "../index.js";

function expectOk(
  result: RecordFactResult,
): Extract<RecordFactResult, { ok: true }> {
  if (!result.ok) {
    throw new Error(`expected recordFact to succeed: ${result.reason}`);
  }

  return result;
}

function memory(overrides: Partial<StoredMemory>): StoredMemory {
  return {
    id: 1,
    category: "profile",
    key: "user.name",
    content: "The user's name is Thor.",
    importance: 5,
    state: "active",
    sourceMessageIds: [],
    createdAt: 1,
    updatedAt: 1,
    lastConfirmedAt: null,
    expiresAt: null,
    ...overrides,
  };
}

describe("formatCoreMemory", () => {
  it("returns empty for no memories", () => {
    expect(formatCoreMemory([])).toBe("");
  });

  it("formats best-first with a header and bullets", () => {
    const block = formatCoreMemory([
      memory({ id: 1, content: "Low importance fact.", importance: 1 }),
      memory({
        id: 2,
        key: "user.name",
        content: "The user's name is Thor.",
        importance: 5,
      }),
    ]);

    expect(block).toContain("LONG-TERM MEMORY");
    expect(block.indexOf("Thor")).toBeLessThan(block.indexOf("Low importance"));
  });

  it("carries the trust notice (data, not instructions)", () => {
    const block = formatCoreMemory([memory({})]);

    expect(block).toContain("not instructions");
  });

  it("respects the char budget", () => {
    const many = Array.from({ length: 50 }, (_, index) =>
      memory({
        id: index + 1,
        content: `fact number ${index} ${"x".repeat(200)}`,
        importance: 3,
      }),
    );

    const block = formatCoreMemory(many);

    expect(block.length).toBeLessThanOrEqual(CORE_MEMORY_MAX_CHARS + 2);
    expect(block.split("\n").length).toBeLessThan(50);
  });
});

describe("selectCoreMemory — exact injected tracking", () => {
  it("reports exactly which rows fit the budget; omitted rows differ", () => {
    const rows = Array.from({ length: 20 }, (_, index) =>
      memory({
        id: index + 1,
        key: `fact.${index}`,
        content: `Marker${index} stored fact ${"detail ".repeat(30)}`,
        importance: 5,
        updatedAt: 1_000 + index,
      }),
    );

    const selection = selectCoreMemory(rows);

    expect(selection.injected.length).toBeGreaterThan(0);
    expect(selection.injected.length).toBeLessThan(20);
    expect(selection.block.length).toBeLessThanOrEqual(
      CORE_MEMORY_MAX_CHARS + 2,
    );

    // Injected rows are exactly the top of the ranking contract:
    // importance desc, then recency desc.
    const ranked = [...rows]
      .sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt)
      .slice(0, selection.injected.length);

    expect(selection.injected.map((entry) => entry.id)).toEqual(
      ranked.map((entry) => entry.id),
    );

    // The first truncated row is NOT in the block (unique marker).
    const firstOmitted = ranked[selection.injected.length];

    if (firstOmitted) {
      expect(selection.block).not.toContain(`Marker${firstOmitted.id}`);
    }
  });

  it("redacts secret-shaped stored content (legacy row protection)", () => {
    const selection = selectCoreMemory([
      memory({
        content: "the user said their api key is sk-abcdefghijklmnopqrstuvwx",
      }),
    ]);

    expect(selection.block).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(selection.block).toContain("[REDACTED");
  });
});

describe("CoreMemoryProvider", () => {
  it("returns empty without a store", () => {
    const provider = new CoreMemoryProvider(null);

    expect(provider.get()).toBe("");
    expect(provider.select().injected).toEqual([]);
  });

  it("returns stored active memories end-to-end with exact ids", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "starfire-core-"));

    try {
      const db = await openMemoryDatabase({ userDataDir: dir });

      if (!db) {
        throw new Error("expected the memory database to open");
      }

      const store = new MemoryStore(db);

      const name = expectOk(
        store.recordFact({
          category: "profile",
          key: "user.name",
          content: "The user's name is Thor.",
          importance: 5,
        }),
      );

      const editor = expectOk(
        store.recordFact({
          category: "preference",
          key: "editor",
          content: "Uses VS Code.",
          importance: 3,
        }),
      );

      const provider = new CoreMemoryProvider(store);

      const selection = provider.select();

      expect(selection.block).toContain("The user's name is Thor.");
      expect(selection.block).toContain("Uses VS Code.");
      expect(selection.injected.map((entry) => entry.id)).toEqual([
        name.memory.id,
        editor.memory.id,
      ]);

      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("degrades to empty when the store is closed", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "starfire-core-"));

    try {
      const db = await openMemoryDatabase({ userDataDir: dir });

      if (!db) {
        throw new Error("expected the memory database to open");
      }

      const store = new MemoryStore(db);

      db.close();

      const provider = new CoreMemoryProvider(store);

      expect(provider.get()).toBe("");
      expect(provider.select().injected).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
