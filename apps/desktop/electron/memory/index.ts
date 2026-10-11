/*
 * Memory V1.1 — public entry point.
 *
 * Everything outside electron/memory imports from this door. The
 * orchestrator slice will hang its exports here too.
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
  buildExtractionMessages,
  DEFAULT_EXTRACTION_TIMEOUT_MS,
  DEFAULT_MAX_REQUESTS_PER_MINUTE,
  DEFAULT_MAX_TOKENS_PER_MINUTE,
  DEFAULT_MEMORY_BASE_URL,
  DEFAULT_MEMORY_MODEL,
  DEFAULT_MIN_INTERVAL_MS,
  EXTRACTION_CONTEXT_TURNS,
  EXTRACTION_MAX_DRAFTS,
  EXTRACTION_MAX_OUTPUT_TOKENS,
  type ExtractedMemoryDraft,
  type ExtractionConfig,
  type ExtractionFailure,
  type ExtractionFailureKind,
  type ExtractionResult,
  type ExtractionTurn,
  GlmExtractionProvider,
  parseExtractionPayload,
  resolveExtractionConfig,
} from "./extraction.js";
export {
  EXTRACTION_BATCH_MAX_CHARS,
  EXTRACTION_BATCH_MAX_MESSAGES,
  fitBatch,
  MAX_JOB_ATTEMPTS,
  MAX_JOB_ERROR_CHARS,
  type MemoryJob,
  type MemoryJobStatus,
  MemoryJobs,
  nextRetryDelayMs,
  RETRY_BASE_MS,
  RETRY_JITTER_MS,
  RETRY_MAX_MS,
  STALE_RUNNING_MS,
} from "./jobs.js";

export {
  DEFAULT_IMPORTANCE,
  isMemoryCategory,
  MAX_IMPORTANCE,
  MAX_KEY_CHARS,
  MAX_MEMORY_CHARS,
  MAX_SOURCE_IDS,
  MEMORY_CATEGORIES,
  type MemoryCategory,
  type MemoryInput,
  type MemoryState,
  MemoryStore,
  normalizeKey,
  type RecordFactAction,
  type RecordFactResult,
  type StoredMemory,
} from "./memories.js";
export {
  type InsertTurnInput,
  MAX_MESSAGE_CHARS,
  MessageStore,
  type StoredRole,
  type StoredTurn,
} from "./messages.js";
export {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  type Migration,
  runMigrations,
} from "./migrations.js";

export {
  ExtractionRateLimiter,
  estimateTokens,
  WINDOW_MS,
} from "./rate-limit.js";

export {
  type RedactionResult,
  redactSecrets,
  redactTurns,
} from "./redaction.js";
