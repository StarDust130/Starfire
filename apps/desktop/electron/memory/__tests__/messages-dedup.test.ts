import { mkdtemp, rm } from "node:fs/promises";

import { tmpdir } from "node:os";

import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type MemoryDatabase,
  MessageStore,
  openMemoryDatabase,
} from "../index.js";

let userDataDir = "";

beforeEach(async () => {
  userDataDir = await mkdtemp(path.join(tmpdir(), "starfire-dedup-"));
});

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
});

async function openStore(): Promise<{
  db: MemoryDatabase;
  messages: MessageStore;
}> {
  const db = await openMemoryDatabase({ userDataDir });

  if (!db) {
    throw new Error("expected the memory database to open");
  }

  return { db, messages: new MessageStore(db) };
}

describe("MessageStore replay deduplication", () => {
  it("rejects an identical replay inside the window", async () => {
    const { messages } = await openStore();

    const first = messages.insertTurn(
      {
        sessionId: "s1",
        role: "user",
        content: "hello there",
      },
      1_000,
    );

    expect(first).not.toBeNull();

    // Same event delivered again 500ms later: provider echo, not speech.
    const replay = messages.insertTurn(
      {
        sessionId: "s1",
        role: "user",
        content: "hello there",
      },
      1_500,
    );

    expect(replay).toBeNull();
    expect(messages.listSessionTurns("s1")).toHaveLength(1);
  });

  it("stores the same words again AFTER the window (legitimate repeat)", async () => {
    const { messages } = await openStore();

    messages.insertTurn(
      { sessionId: "s1", role: "user", content: "bye" },
      1_000,
    );

    const later = messages.insertTurn(
      { sessionId: "s1", role: "user", content: "bye" },
      1_000 + 5_000,
    );

    expect(later).not.toBeNull();
    expect(messages.listSessionTurns("s1")).toHaveLength(2);
  });

  it("never suppresses legitimate different messages", async () => {
    const { messages } = await openStore();

    messages.insertTurn(
      { sessionId: "s1", role: "user", content: "Okay." },
      1_000,
    );

    const second = messages.insertTurn(
      { sessionId: "s1", role: "user", content: "Bye." },
      1_100,
    );

    expect(second).not.toBeNull();
    expect(messages.listSessionTurns("s1")).toHaveLength(2);
  });

  it("same words different role are NOT a replay", async () => {
    const { messages } = await openStore();

    messages.insertTurn(
      { sessionId: "s1", role: "user", content: "ok" },
      1_000,
    );

    const assistant = messages.insertTurn(
      { sessionId: "s1", role: "assistant", content: "ok" },
      1_200,
    );

    expect(assistant).not.toBeNull();
    expect(messages.listSessionTurns("s1")).toHaveLength(2);
  });
});
