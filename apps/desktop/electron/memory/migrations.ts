import type { DatabaseSync } from "node:sqlite";

/*
 * Versioned schema migrations.
 *
 * Rules:
 * - Each migration runs in its own transaction. If anything fails,
 *   it rolls back fully and the version is NOT recorded, so the
 *   next start retries it safely.
 * - Already-applied migrations are skipped (idempotent across
 *   restarts and crash recovery).
 * - NEVER edit an applied migration. Add a new one with version + 1.
 */

export const LATEST_SCHEMA_VERSION = 2;

export type Migration = {
  version: number;
  name: string;
  sql: string;
};

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "core memory tables",
    sql: `
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        interrupted INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        processed_at INTEGER
      );

      -- Replay protection: the same turn of the same session can only
      -- be stored once, no matter how often capture retries.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_session_turn
        ON messages (session_id, turn_index, role);

      -- Fast lookup of not-yet-processed messages for extraction.
      CREATE INDEX IF NOT EXISTS idx_messages_pending
        ON messages (processed_at, id);

      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL CHECK (
          category IN ('profile', 'preference', 'goal', 'project', 'fact', 'event')
        ),
        key TEXT NOT NULL,
        content TEXT NOT NULL,
        importance INTEGER NOT NULL DEFAULT 3 CHECK (
          importance >= 1 AND importance <= 5
        ),
        state TEXT NOT NULL DEFAULT 'active' CHECK (
          state IN ('active', 'superseded', 'archived')
        ),
        source_message_ids TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_confirmed_at INTEGER,
        expires_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_memories_active
        ON memories (state, category, updated_at DESC);

      -- Durable extraction queue: which messages, how many attempts,
      -- when the next retry is allowed.
      CREATE TABLE IF NOT EXISTS memory_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (
          status IN ('pending', 'running', 'done', 'failed')
        ),
        message_ids TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        run_after INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memory_jobs_pending
        ON memory_jobs (status, run_after);
    `,
  },
  {
    version: 2,
    name: "one active memory per key",
    sql: `
      -- Safety before creating the partial unique index: demote any
      -- duplicate active rows, keeping only the newest per
      -- (category, key).
      UPDATE memories
      SET state = 'superseded'
      WHERE state = 'active'
        AND id NOT IN (
          SELECT MAX(id) FROM memories WHERE state = 'active' GROUP BY category, key
        );

      -- Core invariant: at most ONE active memory per (category, key).
      -- Superseded/archived rows may share the key freely.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_active_key
        ON memories (category, key) WHERE state = 'active';
    `,
  },
];

const BOOTSTRAP_SQL = `
  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  );
`;

export function currentSchemaVersion(db: DatabaseSync): number {
  db.exec(BOOTSTRAP_SQL);

  const row = db
    .prepare("SELECT MAX(version) AS version FROM schema_version")
    .get();

  const version = row?.version;

  return typeof version === "number" ? version : 0;
}

export function runMigrations(
  db: DatabaseSync,
  migrations: readonly Migration[] = MIGRATIONS,
): number {
  db.exec(BOOTSTRAP_SQL);

  let current = currentSchemaVersion(db);

  const pending = [...migrations]
    .sort((a, b) => a.version - b.version)
    .filter((migration) => migration.version > current);

  for (const migration of pending) {
    db.exec("BEGIN IMMEDIATE");

    try {
      db.exec(migration.sql);

      db.prepare(
        "INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)",
      ).run(migration.version, migration.name, Date.now());

      db.exec("COMMIT");

      current = migration.version;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The transaction may already be gone; nothing left to protect.
      }

      const message = error instanceof Error ? error.message : String(error);

      throw new Error(
        `Memory migration v${migration.version} (${migration.name}) failed: ${message}`,
      );
    }
  }

  return current;
}
