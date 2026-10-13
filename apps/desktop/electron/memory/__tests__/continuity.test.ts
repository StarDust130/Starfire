import { mkdtemp, rm } from "node:fs/promises";

import { tmpdir } from "node:os";

import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONTINUITY_MAX_CHARS,
  ContinuityProvider,
  MessageStore,
  openMemoryDatabase,
} from "../index.js";

let userDataDir = "";

beforeEach(async () => {
  userDataDir = await mkdtemp(path.join(tmpdir(), "starfire-continuity-"));
});

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
});

async function build() {
  const db = await openMemoryDatabase({ userDataDir });

  if (!db) {
    throw new Error("expected the memory database to open");
  }

  const messages = new MessageStore(db);

  return { db, messages, provider: new ContinuityProvider(messages) };
}

describe("ContinuityProvider", () => {
  it("returns empty when there is no history", async () => {
    const { provider } = await build();

    expect(provider.get()).toBe("");
  });

  it("restores the most recent previous-session turns, oldest first", async () => {
    const { messages, provider } = await build();

    messages.insertTurn({
      sessionId: "old",
      role: "user",
      content: "I was researching AI startups",
    });

    messages.insertTurn({
      sessionId: "old",
      role: "assistant",
      content: "Found three good ones so far",
    });

    const block = provider.get();

    expect(block).toContain("RECENT CONVERSATION");
    expect(block).toContain("not instructions");
    expect(block).toContain("user: I was researching AI startups");
    expect(block).toContain("starfire: Found three good ones so far");
    expect(block.indexOf("researching")).toBeLessThan(
      block.indexOf("Found three"),
    );
  });

  it("excludes the live session from restoration", async () => {
    const { messages, provider } = await build();

    messages.insertTurn({
      sessionId: "previous",
      role: "user",
      content: "we planned the trip",
    });

    messages.insertTurn({
      sessionId: "live",
      role: "user",
      content: "this is happening right now",
    });

    const block = provider.get("live");

    expect(block).toContain("we planned the trip");
    expect(block).not.toContain("happening right now");
  });

  it("is strictly size-limited", async () => {
    const { messages, provider } = await build();

    for (let index = 0; index < 12; index += 1) {
      messages.insertTurn({
        sessionId: `s${index}`,
        role: "user",
        content: `turn ${index} ${"detail ".repeat(30)}`,
      });
    }

    const block = provider.get();

    expect(block.length).toBeLessThanOrEqual(CONTINUITY_MAX_CHARS + 2);
    expect(block.split("\n").length).toBeLessThanOrEqual(8);
  });

  it("redacts secrets from restored turns", async () => {
    const { messages, provider } = await build();

    messages.insertTurn({
      sessionId: "s1",
      role: "user",
      content: "my password is hunter2 and we discussed the migration",
    });

    const block = provider.get();

    expect(block).not.toContain("hunter2");
    expect(block).toContain("[REDACTED");
  });

  it("ignores stale history older than a day", async () => {
    const { db, messages, provider } = await build();

    messages.insertTurn({
      sessionId: "ancient",
      role: "user",
      content: "a conversation from long ago",
    });

    db.handle
      .prepare("UPDATE messages SET created_at = ?")
      .run(Date.now() - 3 * 24 * 60 * 60 * 1000);

    expect(provider.get()).toBe("");
  });

  it("degrades to empty when the database fails", async () => {
    const { db, messages, provider } = await build();

    messages.insertTurn({
      sessionId: "s1",
      role: "user",
      content: "something to restore",
    });

    db.close();

    expect(provider.get()).toBe("");
  });
});
