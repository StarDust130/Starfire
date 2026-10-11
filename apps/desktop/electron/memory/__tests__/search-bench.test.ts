import { mkdtemp, rm } from "node:fs/promises";

import { tmpdir } from "node:os";

import path from "node:path";

import { describe, expect, it } from "vitest";

import { MemorySearch, openMemoryDatabase } from "../index.js";

/*
 * Opt-in scalability benchmark (the audit's 10k / 100k requirement):
 *
 *   STARFIRE_BENCH=1 pnpm --filter desktop exec vitest run search-bench
 *
 * Also probes whether this node:sqlite runtime supports FTS5 — the
 * input for the future upgrade decision. Skipped by default so the
 * normal suite stays fast.
 */

const enabled = process.env.STARFIRE_BENCH === "1";

async function bench(count: number, ceilingMsPerQuery: number): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "starfire-bench-"));

  try {
    const db = await openMemoryDatabase({ userDataDir: dir });

    if (!db) {
      throw new Error("expected the memory database to open");
    }

    const insert = db.handle.prepare(
      "INSERT INTO messages (session_id, turn_index, role, content, interrupted, created_at) VALUES (?, ?, ?, ?, 0, ?)",
    );

    const insertStarted = Date.now();

    db.withTransaction(() => {
      for (let index = 0; index < count; index += 1) {
        insert.run(
          "bench",
          index,
          index % 2 === 0 ? "user" : "assistant",
          `bench message ${index} about topic-${index % 50} and project alpha details`,
          Date.now(),
        );
      }
    });

    const search = new MemorySearch(db);

    search.search("topic alpha"); // warm-up

    const runs = 20;

    const started = performance.now();

    for (let round = 0; round < runs; round += 1) {
      const result = search.search(`topic ${round % 50} alpha`);

      if (result.messages.length === 0) {
        throw new Error("benchmark query unexpectedly returned nothing");
      }
    }

    const perQueryMs = (performance.now() - started) / runs;

    console.log(
      `[bench] messages=${count} insertMs=${Date.now() - insertStarted} avgQueryMs=${perQueryMs.toFixed(2)}`,
    );

    expect(perQueryMs).toBeLessThan(ceilingMsPerQuery);

    // FTS5 capability probe for the future upgrade decision.
    try {
      db.handle.exec(
        "CREATE VIRTUAL TABLE temp.starfire_fts_probe USING fts5(content)",
      );

      console.log("[bench] FTS5: available in this node:sqlite runtime");
    } catch {
      console.log("[bench] FTS5: NOT available in this node:sqlite runtime");
    }

    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!enabled)("search benchmarks", () => {
  it("handles a 10,000-message history", async () => {
    await bench(10_000, 250);
  }, 120_000);

  it("handles a 100,000-message history", async () => {
    await bench(100_000, 2_000);
  }, 300_000);
});
