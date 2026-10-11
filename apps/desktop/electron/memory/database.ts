import { mkdir } from "node:fs/promises";

import path from "node:path";

import { DatabaseSync } from "node:sqlite";

import { resolveMemoryConfig } from "./config.js";
import { runMigrations } from "./migrations.js";

export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

export type MemoryDatabaseOptions = {
  /** The app's user data directory (app.getPath("userData") in main). */
  userDataDir: string;

  /** How long a write waits for a competing connection, in ms. */
  busyTimeoutMs?: number;

  /** Environment override; defaults to process.env. Test seam. */
  env?: NodeJS.ProcessEnv;
};

export type MemoryDatabase = {
  /** Absolute path of the SQLite file. */
  path: string;

  /** Schema version after migrations (LATEST on a fresh database). */
  schemaVersion: number;

  /** The underlying node:sqlite handle for repository code. */
  handle: DatabaseSync;

  /**
   * Runs fn inside one BEGIN IMMEDIATE transaction. On error the
   * transaction rolls back and the error is rethrown. Not reentrant.
   */
  withTransaction<T>(fn: () => T): T;

  /** Idempotent close; safe to call more than once during shutdown. */
  close(): void;
};

/**
 * Opens (and on first run creates) the memory database.
 *
 * Returns null when memory is disabled by configuration — callers must
 * treat null as "run without memory", not as an error. Throws only on
 * real infrastructure failures; main catches those and continues
 * without memory rather than taking Starfire down.
 */
export async function openMemoryDatabase(
  options: MemoryDatabaseOptions,
): Promise<MemoryDatabase | null> {
  const config = resolveMemoryConfig(options.userDataDir, options.env);

  if (!config.enabled) {
    return null;
  }

  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;

  await mkdir(path.dirname(config.databasePath), { recursive: true });

  const handle = new DatabaseSync(config.databasePath);

  try {
    /*
     * WAL lets voice reads and background writes share the file
     * without fighting; busy_timeout makes lock contention wait
     * briefly instead of failing instantly.
     */
    handle.exec("PRAGMA journal_mode = WAL;");
    handle.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
    handle.exec("PRAGMA foreign_keys = ON;");

    const schemaVersion = runMigrations(handle);

    let closed = false;
    let inTransaction = false;

    return {
      path: config.databasePath,
      schemaVersion,
      handle,

      withTransaction<T>(fn: () => T): T {
        if (closed) {
          throw new Error("Memory database is closed.");
        }

        if (inTransaction) {
          throw new Error("Nested memory transactions are not supported.");
        }

        inTransaction = true;

        handle.exec("BEGIN IMMEDIATE");

        try {
          const result = fn();

          handle.exec("COMMIT");

          inTransaction = false;

          return result;
        } catch (error) {
          try {
            handle.exec("ROLLBACK");
          } catch {
            // Nothing left to protect; surface the original error.
          }

          inTransaction = false;

          throw error;
        }
      },

      close(): void {
        if (closed) {
          return;
        }

        closed = true;

        handle.close();
      },
    };
  } catch (error) {
    try {
      handle.close();
    } catch {
      // Nothing else to clean up.
    }

    throw error;
  }
}
