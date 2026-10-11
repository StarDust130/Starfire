import { existsSync } from "node:fs";

import { mkdtemp, rm } from "node:fs/promises";

import { tmpdir } from "node:os";

import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MEMORY_DB_FILE_NAME,
  MEMORY_DB_PATH_ENV,
  MEMORY_DIR_NAME,
  MEMORY_DISABLED_ENV,
  type MemoryDatabase,
  openMemoryDatabase,
} from "../index.js";

let userDataDir = "";

beforeEach(async () => {
  userDataDir = await mkdtemp(path.join(tmpdir(), "starfire-memory-"));
});

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
});

/*
 * SQLite names PRAGMA result columns inconsistently across pragmas
 * and builds (busy_timeout reports its column as "timeout"). Read
 * the first column's value instead of depending on a column name.
 */
function pragmaFirstValue(db: MemoryDatabase["handle"], sql: string): unknown {
  const row = db.prepare(sql).get();

  return row ? Object.values(row)[0] : undefined;
}

function openOrThrow(db: MemoryDatabase | null): MemoryDatabase {
  if (!db) {
    throw new Error("expected the memory database to open");
  }

  return db;
}

function insertMessage(db: MemoryDatabase, content: string): void {
  db.handle
    .prepare(
      "INSERT INTO messages (session_id, turn_index, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("test-session", 0, "user", content, Date.now());
}

describe("openMemoryDatabase", () => {
  it("returns null when disabled and creates nothing on disk", async () => {
    const db = await openMemoryDatabase({
      userDataDir,
      env: { [MEMORY_DISABLED_ENV]: "1" },
    });

    expect(db).toBeNull();
    expect(existsSync(path.join(userDataDir, MEMORY_DIR_NAME))).toBe(false);
  });

  it("creates the database, enables WAL, and applies migrations", async () => {
    const memory = openOrThrow(await openMemoryDatabase({ userDataDir }));

    expect(memory.schemaVersion).toBe(1);
    expect(memory.path).toBe(
      path.join(userDataDir, MEMORY_DIR_NAME, MEMORY_DB_FILE_NAME),
    );
    expect(existsSync(memory.path)).toBe(true);

    const journalMode = String(
      pragmaFirstValue(memory.handle, "PRAGMA journal_mode"),
    ).toLowerCase();

    expect(journalMode).toBe("wal");

    const busyTimeout = Number(
      pragmaFirstValue(memory.handle, "PRAGMA busy_timeout"),
    );

    expect(busyTimeout).toBe(5_000);

    memory.close();
  });

  it("honors a custom busy timeout", async () => {
    const memory = openOrThrow(
      await openMemoryDatabase({ userDataDir, busyTimeoutMs: 123 }),
    );

    const busyTimeout = Number(
      pragmaFirstValue(memory.handle, "PRAGMA busy_timeout"),
    );

    expect(busyTimeout).toBe(123);

    memory.close();
  });

  it("honors the database path override", async () => {
    const customPath = path.join(userDataDir, "custom", "place", "my.db");

    const memory = openOrThrow(
      await openMemoryDatabase({
        userDataDir,
        env: { [MEMORY_DB_PATH_ENV]: customPath },
      }),
    );

    expect(memory.path).toBe(path.resolve(customPath));
    expect(existsSync(customPath)).toBe(true);

    memory.close();
  });

  it("commits a transaction and the data is visible", async () => {
    const memory = openOrThrow(await openMemoryDatabase({ userDataDir }));

    memory.withTransaction(() => {
      insertMessage(memory, "hello");
    });

    const row = memory.handle.prepare("SELECT content FROM messages").get();

    expect(row?.content).toBe("hello");

    memory.close();
  });

  it("rolls back a failed transaction and stays usable", async () => {
    const memory = openOrThrow(await openMemoryDatabase({ userDataDir }));

    expect(() =>
      memory.withTransaction(() => {
        insertMessage(memory, "doomed");
        throw new Error("boom");
      }),
    ).toThrow("boom");

    const rows = memory.handle
      .prepare("SELECT COUNT(*) AS count FROM messages")
      .get();

    expect(Number(rows?.count)).toBe(0);

    memory.withTransaction(() => {
      insertMessage(memory, "recovered");
    });

    const after = memory.handle
      .prepare("SELECT COUNT(*) AS count FROM messages")
      .get();

    expect(Number(after?.count)).toBe(1);

    memory.close();
  });

  it("makes a competing connection wait, then fail cleanly", async () => {
    const a = openOrThrow(
      await openMemoryDatabase({ userDataDir, busyTimeoutMs: 50 }),
    );
    const b = openOrThrow(
      await openMemoryDatabase({ userDataDir, busyTimeoutMs: 50 }),
    );

    a.handle.exec("BEGIN IMMEDIATE");
    insertMessage(a, "holding the lock");

    expect(() => insertMessage(b, "blocked")).toThrow(/locked/i);

    a.handle.exec("ROLLBACK");

    a.close();
    b.close();
  });

  it("survives close being called twice", async () => {
    const memory = openOrThrow(await openMemoryDatabase({ userDataDir }));

    memory.close();

    expect(() => memory.close()).not.toThrow();
  });

  it("persists data across reopen without re-migrating", async () => {
    const first = openOrThrow(await openMemoryDatabase({ userDataDir }));

    first.withTransaction(() => {
      insertMessage(first, "still here");
    });

    first.close();

    const second = openOrThrow(await openMemoryDatabase({ userDataDir }));

    expect(second.schemaVersion).toBe(1);

    const row = second.handle.prepare("SELECT content FROM messages").get();

    expect(row?.content).toBe("still here");

    const versions = second.handle
      .prepare("SELECT COUNT(*) AS count FROM schema_version")
      .get();

    expect(Number(versions?.count)).toBe(1);

    second.close();
  });
});
