import { mkdtemp, rm } from "node:fs/promises";

import { tmpdir } from "node:os";

import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSessionUpdate } from "../../realtimeProtocol";
import {
  CORE_MEMORY_MAX_CHARS,
  CoreMemoryProvider,
  formatCoreMemory,
  MemoryStore,
  openMemoryDatabase,
  type StoredMemory,
} from "../index.js";

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

describe("CoreMemoryProvider", () => {
  it("returns empty without a store", () => {
    expect(new CoreMemoryProvider(null).get()).toBe("");
  });

  it("returns stored active memories end-to-end", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "starfire-core-"));

    try {
      const db = await openMemoryDatabase({ userDataDir: dir });

      if (!db) {
        throw new Error("expected the memory database to open");
      }

      const store = new MemoryStore(db);

      store.recordFact({
        category: "profile",
        key: "user.name",
        content: "The user's name is Thor.",
        importance: 5,
      });

      store.recordFact({
        category: "preference",
        key: "editor",
        content: "Uses VS Code.",
        importance: 3,
      });

      const block = new CoreMemoryProvider(store).get();

      expect(block).toContain("The user's name is Thor.");
      expect(block).toContain("Uses VS Code.");

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

      expect(new CoreMemoryProvider(store).get()).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("buildSessionUpdate with core memory", () => {
  it("appends the memory block to instructions", () => {
    const payload = JSON.parse(
      buildSessionUpdate(
        [],
        "LONG-TERM MEMORY about the user:\n- The user's name is Thor.",
      ),
    );

    const instructions = String(payload.session.instructions);

    expect(instructions).toContain("The user's name is Thor.");
    expect(instructions).toContain("You are Starfire");
  });

  it("leaves instructions unchanged when memory is empty", () => {
    const payload = JSON.parse(buildSessionUpdate([], ""));

    expect(payload.session.instructions).not.toContain("LONG-TERM MEMORY");
  });
});
