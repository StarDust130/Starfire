import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  type Migration,
  runMigrations,
} from "../migrations.js";

function freshDb(): DatabaseSync {
  return new DatabaseSync(":memory:");
}

function tableNames(db: DatabaseSync): string[] {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map((row) => String(row.name));
}

function indexNames(db: DatabaseSync): string[] {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name",
    )
    .all()
    .map((row) => String(row.name));
}

function schemaVersion(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT MAX(version) AS version FROM schema_version")
    .get();

  return Number(row?.version ?? 0);
}

function insertMemory(
  db: DatabaseSync,
  category: string,
  key: string,
  content: string,
): number {
  const now = Date.now();

  const result = db
    .prepare(
      "INSERT INTO memories (category, key, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(category, key, content, now, now);

  return Number(result.lastInsertRowid);
}

describe("runMigrations", () => {
  it("applies all migrations to a fresh database", () => {
    const db = freshDb();

    const version = runMigrations(db);

    expect(version).toBe(LATEST_SCHEMA_VERSION);
    expect(version).toBe(2);

    const tables = tableNames(db);

    expect(tables).toEqual(
      expect.arrayContaining([
        "schema_version",
        "messages",
        "memories",
        "memory_jobs",
      ]),
    );

    db.close();
  });

  it("is idempotent — running twice changes nothing", () => {
    const db = freshDb();

    expect(runMigrations(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(runMigrations(db)).toBe(LATEST_SCHEMA_VERSION);

    const rows = db
      .prepare("SELECT COUNT(*) AS count FROM schema_version")
      .get();

    expect(Number(rows?.count)).toBe(MIGRATIONS.length);

    db.close();
  });

  it("creates the one-active-per-key partial index", () => {
    const db = freshDb();

    runMigrations(db);

    expect(indexNames(db)).toContain("idx_memories_active_key");

    db.close();
  });

  it("enforces one active memory per (category, key)", () => {
    const db = freshDb();

    runMigrations(db);

    const first = insertMemory(db, "profile", "user-name", "Thor");

    expect(first).toBeGreaterThan(0);

    expect(() =>
      insertMemory(db, "profile", "user-name", "Someone else"),
    ).toThrow(/UNIQUE/i);

    // A different category is a different slot.
    insertMemory(db, "fact", "user-name", "different slot");

    // A non-active row frees the slot again.
    db.prepare(
      "UPDATE memories SET state = 'superseded' WHERE category = 'profile'",
    ).run();

    expect(() =>
      insertMemory(db, "profile", "user-name", "allowed again"),
    ).not.toThrow();

    db.close();
  });

  it("demotes duplicate active rows when upgrading v1 -> v2", () => {
    const db = freshDb();

    runMigrations(
      db,
      MIGRATIONS.filter((migration) => migration.version === 1),
    );

    expect(schemaVersion(db)).toBe(1);

    const oldId = insertMemory(db, "profile", "user-name", "old value");
    const newId = insertMemory(db, "profile", "user-name", "new value");

    expect(runMigrations(db)).toBe(2);

    const oldRow = db
      .prepare("SELECT state FROM memories WHERE id = ?")
      .get(oldId);
    const newRow = db
      .prepare("SELECT state FROM memories WHERE id = ?")
      .get(newId);

    expect(String(oldRow?.state)).toBe("superseded");
    expect(String(newRow?.state)).toBe("active");

    const active = db
      .prepare("SELECT COUNT(*) AS count FROM memories WHERE state = 'active'")
      .get();

    expect(Number(active?.count)).toBe(1);

    const versions = db
      .prepare("SELECT COUNT(*) AS count FROM schema_version")
      .get();

    expect(Number(versions?.count)).toBe(2);

    db.close();
  });

  it("rolls back a failed migration and stays usable for a retry", () => {
    const db = freshDb();

    expect(runMigrations(db)).toBe(LATEST_SCHEMA_VERSION);

    const broken: readonly Migration[] = [
      ...MIGRATIONS,
      {
        version: LATEST_SCHEMA_VERSION + 1,
        name: "broken",
        sql: "CREATE TABLE oops (",
      },
    ];

    expect(() => runMigrations(db, broken)).toThrow(/v3/);

    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);

    expect(tableNames(db)).not.toContain("oops");

    expect(runMigrations(db, MIGRATIONS)).toBe(LATEST_SCHEMA_VERSION);

    db.close();
  });

  it("enforces the message role enum at the database level", () => {
    const db = freshDb();

    runMigrations(db);

    expect(() =>
      db
        .prepare(
          "INSERT INTO messages (session_id, turn_index, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("s1", 0, "system", "should not exist", Date.now()),
    ).toThrow(/CHECK/i);

    db.close();
  });

  it("enforces the memory category enum at the database level", () => {
    const db = freshDb();

    runMigrations(db);

    const now = Date.now();

    expect(() =>
      db
        .prepare(
          "INSERT INTO memories (category, key, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("junk", "likes.color", "blue", now, now),
    ).toThrow(/CHECK/i);

    db.close();
  });

  it("enforces the importance range at the database level", () => {
    const db = freshDb();

    runMigrations(db);

    const now = Date.now();

    expect(() =>
      db
        .prepare(
          "INSERT INTO memories (category, key, content, importance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("fact", "test.key", "content", 9, now, now),
    ).toThrow(/CHECK/i);

    db.close();
  });

  it("rejects a replayed session turn via the unique index", () => {
    const db = freshDb();

    runMigrations(db);

    const insert = db.prepare(
      "INSERT INTO messages (session_id, turn_index, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
    );

    insert.run("s1", 0, "user", "hello", Date.now());

    expect(() =>
      insert.run("s1", 0, "user", "hello again", Date.now()),
    ).toThrow(/UNIQUE/i);

    db.close();
  });
});
