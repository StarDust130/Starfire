import path from "node:path";

/*
 * Decides WHERE memory lives, and how to switch it off.
 *
 * STARFIRE_MEMORY_DB_PATH  -> use a custom database file (debug/tests).
 * STARFIRE_MEMORY_DISABLED -> "1"/"true" disables memory completely:
 *                             no database, no folders, no errors.
 */

export const MEMORY_DIR_NAME = "memory";

export const MEMORY_DB_FILE_NAME = "starfire.db";

export const MEMORY_DISABLED_ENV = "STARFIRE_MEMORY_DISABLED";

export const MEMORY_DB_PATH_ENV = "STARFIRE_MEMORY_DB_PATH";

export type MemoryConfig = {
  enabled: boolean;
  databasePath: string;
};

function isTruthyFlag(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();

  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

export function resolveMemoryConfig(
  userDataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): MemoryConfig {
  const override = env[MEMORY_DB_PATH_ENV]?.trim();

  const databasePath =
    override && override.length > 0
      ? path.resolve(override)
      : path.join(userDataDir, MEMORY_DIR_NAME, MEMORY_DB_FILE_NAME);

  return {
    enabled: !isTruthyFlag(env[MEMORY_DISABLED_ENV]),
    databasePath,
  };
}
