/*
 * Memory V1.1 — public entry point.
 *
 * Everything outside electron/memory imports from this door. Later
 * slices (message capture, memory store, job queue, GLM extraction)
 * will hang their exports here too.
 */

export {
  MEMORY_DB_FILE_NAME,
  MEMORY_DB_PATH_ENV,
  MEMORY_DIR_NAME,
  MEMORY_DISABLED_ENV,
  type MemoryConfig,
  resolveMemoryConfig,
} from "./config.js";

export {
  DEFAULT_BUSY_TIMEOUT_MS,
  type MemoryDatabase,
  type MemoryDatabaseOptions,
  openMemoryDatabase,
} from "./database.js";

export {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  type Migration,
  runMigrations,
} from "./migrations.js";
