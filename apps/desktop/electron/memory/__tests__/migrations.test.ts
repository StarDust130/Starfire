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

describe("runMigrations", () => {
  it("applies all migrations to a fresh database", () => {
    const db = freshDb();

    const version = runMigrations(db);

    expect(version).toBe(LATEST_SCHEMA_VERSION);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row) => String(row.name));

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

  it("rolls back a failed migration and stays usable for a retry", () => {
    const db = freshDb();

    expect(runMigrations(db)).toBe(1);

    const broken: readonly Migration[] = [
      ...MIGRATIONS,
      { version: 2, name: "broken", sql: "CREATE TABLE oops (" },
    ];

    expect(() => runMigrations(db, broken)).toThrow(/v2/);

    const version = db
      .prepare("SELECT MAX(version) AS version FROM schema_version")
      .get();

    expect(Number(version?.version)).toBe(1);

    const hasOops = db
      .prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'oops'",
      )
      .get();

    expect(Number(hasOops?.count)).toBe(0);

    expect(runMigrations(db, MIGRATIONS)).toBe(1);

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
