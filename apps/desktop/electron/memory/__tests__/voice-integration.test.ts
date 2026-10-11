import { mkdtemp, rm } from "node:fs/promises";

import { tmpdir } from "node:os";

import path from "node:path";
import {
  getStarfireCapability,
  STARFIRE_CAPABILITY_NAMES,
  STARFIRE_FUNCTION_SPECS,
} from "@starfire/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  ContextBuilder,
  formatMemorySearchResult,
  type MemoryDatabase,
  MemorySearch,
  MemoryStore,
  MessageStore,
  NO_MEMORY_RESULTS_MESSAGE,
  openMemoryDatabase,
} from "../index.js";

describe("memory_search capability", () => {
  it("is a canonical session capability requiring a query", () => {
    const capability = getStarfireCapability("memory_search");

    expect(capability.kind).toBe("session");
    expect(capability.parameters.required).toEqual(["query"]);
  });

  it("reaches the realtime model through derived function specs", () => {
    const spec = STARFIRE_FUNCTION_SPECS.find(
      (entry) => entry.name === "memory_search",
    );

    expect(spec).toBeDefined();
    expect(spec?.parameters.properties.query?.type).toBe("string");
    expect(STARFIRE_CAPABILITY_NAMES).toContain("memory_search");
  });
});

describe("formatMemorySearchResult", () => {
  it("passes context through unchanged", () => {
    expect(formatMemorySearchResult("RELEVANT MEMORY:\n- fact")).toContain(
      "fact",
    );
  });

  it("never hands the model an empty string", () => {
    expect(formatMemorySearchResult("")).toBe(NO_MEMORY_RESULTS_MESSAGE);
    expect(formatMemorySearchResult("   ")).toBe(NO_MEMORY_RESULTS_MESSAGE);
  });
});

describe("memory_search end to end", () => {
  let userDataDir = "";

  afterEach(async () => {
    if (userDataDir) {
      await rm(userDataDir, { recursive: true, force: true });

      userDataDir = "";
    }
  });

  it("past-chat recall produces a model-safe block", async () => {
    userDataDir = await mkdtemp(path.join(tmpdir(), "starfire-voice-"));

    const db: MemoryDatabase | null = await openMemoryDatabase({
      userDataDir,
    });

    if (!db) {
      throw new Error("expected the memory database to open");
    }

    const messages = new MessageStore(db);

    messages.insertTurn({
      sessionId: "s1",
      role: "user",
      content: "we planned the kyoto trip for spring",
    });

    const builder = new ContextBuilder(
      new MemoryStore(db),
      new MemorySearch(db),
    );

    // Simulate the live session already holding this turn.
    const block = builder.build("kyoto trip", {
      excludeMessageIds: new Set([]),
    });

    const result = formatMemorySearchResult(block);

    expect(result).toContain("kyoto");
    expect(result).not.toBe(NO_MEMORY_RESULTS_MESSAGE);

    // Live-session exclusion really excludes.
    const excluded = builder.build("kyoto trip", {
      excludeMessageIds: new Set([1]),
    });

    expect(excluded).toBe("");

    db.close();
  });
});
