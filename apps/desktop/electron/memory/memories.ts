import type { MemoryDatabase } from "./database.js";

/*
 * The index-card box: durable long-term memories.
 *
 * All decisions live HERE, in application code — never in the model:
 * - keys are normalized so "User Name" and "user name" are one slot
 * - at most ONE active memory per (category, key), enforced by the
 *   database's partial unique index (migration v2) and by this class
 * - a changed fact SUPERSEDES the old row (old row kept as history)
 * - an unchanged fact CONFIRMS the row (freshens timestamps, merges
 *   provenance, may raise importance)
 * - content is capped, importance clamped, source ids sanitized
 */

export const MEMORY_CATEGORIES = [
  "profile",
  "preference",
  "goal",
  "project",
  "fact",
  "event",
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export type MemoryState = "active" | "superseded" | "archived";

export const DEFAULT_IMPORTANCE = 3;

export const MAX_IMPORTANCE = 5;

export const MAX_KEY_CHARS = 120;

export const MAX_MEMORY_CHARS = 1_000;

export const MAX_SOURCE_IDS = 50;

export function isMemoryCategory(value: unknown): value is MemoryCategory {
  return (
    typeof value === "string" &&
    (MEMORY_CATEGORIES as readonly string[]).includes(value)
  );
}

/**
 * Normalizes a memory key: lowercase, invalid characters become
 * dashes, edge separators trimmed, length capped.
 * "  MY  Favorite.color!! " -> "my-favorite.color"
 */
export function normalizeKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, MAX_KEY_CHARS)
    .replace(/^[-.]+|[-.]+$/g, "");
}

export type MemoryInput = {
  category: MemoryCategory;
  key: string;
  content: string;
  importance?: number;
  sourceMessageIds?: number[];
};

export type StoredMemory = {
  id: number;
  category: MemoryCategory;
  key: string;
  content: string;
  importance: number;
  state: MemoryState;
  sourceMessageIds: number[];
  createdAt: number;
  updatedAt: number;
  lastConfirmedAt: number | null;
  expiresAt: number | null;
};

export type RecordFactAction = "inserted" | "confirmed" | "superseded";

export type RecordFactResult =
  | { ok: true; action: RecordFactAction; memory: StoredMemory }
  | { ok: false; reason: string };

function parseSourceIds(raw: unknown): number[] {
  if (typeof raw !== "string" || raw.length === 0) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter(
        (value): value is number =>
          typeof value === "number" && Number.isInteger(value) && value > 0,
      )
      .slice(0, MAX_SOURCE_IDS);
  } catch {
    return [];
  }
}

function sanitizeSourceIds(ids: number[] | undefined): number[] {
  if (!ids || ids.length === 0) {
    return [];
  }

  return [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))].slice(
    0,
    MAX_SOURCE_IDS,
  );
}

function clampImportance(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_IMPORTANCE;
  }

  return Math.min(MAX_IMPORTANCE, Math.max(1, Math.round(value)));
}

/**
 * Equality for the confirm decision: ignores case, punctuation, and
 * apostrophe spelling so "Thor" / "thor" / "The user's name is Thor."
 * count as the same fact instead of superseding each other.
 *
 * Only the comparison is normalized — stored content keeps the newest
 * phrasing.
 */
function sameFactText(a: string, b: string): boolean {
  const clean = (value: string): string =>
    value
      .toLowerCase()
      .replace(/['’`]/g, "")
      .replace(/[^\p{L}\p{N}\s]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();

  const left = clean(a);

  return left.length > 0 && left === clean(b);
}

const SELECT_MEMORY = `
  SELECT id, category, key, content, importance, state,
         source_message_ids, created_at, updated_at,
         last_confirmed_at, expires_at
  FROM memories
`;

export class MemoryStore {
  constructor(private readonly db: MemoryDatabase) {}

  /**
   * The single door a fact walks through. Decides insert vs confirm
   * vs supersede so callers (later: the extraction pipeline) never
   * write memory SQL themselves.
   */
  recordFact(input: MemoryInput): RecordFactResult {
    if (!isMemoryCategory(input.category)) {
      return { ok: false, reason: "invalid category" };
    }

    const key = normalizeKey(input.key);

    if (key.length === 0) {
      return { ok: false, reason: "empty key" };
    }

    const content = input.content.trim().slice(0, MAX_MEMORY_CHARS);

    if (content.length === 0) {
      return { ok: false, reason: "empty content" };
    }

    const importance = clampImportance(input.importance);
    const sourceIds = sanitizeSourceIds(input.sourceMessageIds);

    const existing = this.findActive(input.category, key);

    if (!existing) {
      return {
        ok: true,
        action: "inserted",
        memory: this.insertActive(
          input.category,
          key,
          content,
          importance,
          sourceIds,
        ),
      };
    }

    if (sameFactText(existing.content, content)) {
      return {
        ok: true,
        action: "confirmed",
        memory: this.confirm(existing, content, importance, sourceIds),
      };
    }

    return {
      ok: true,
      action: "superseded",
      memory: this.supersedeAndInsert(
        existing.id,
        input.category,
        key,
        content,
        importance,
        sourceIds,
      ),
    };
  }

  findActive(category: MemoryCategory, key: string): StoredMemory | null {
    const normalized = normalizeKey(key);

    if (normalized.length === 0) {
      return null;
    }

    const row = this.db.handle
      .prepare(
        `${SELECT_MEMORY} WHERE state = 'active' AND category = ? AND key = ?`,
      )
      .get(category, normalized);

    return row ? this.mapRow(row as Record<string, unknown>) : null;
  }

  /** Active memories only, best-first: importance, then recency. */
  listActive(limit = 100): StoredMemory[] {
    const rows = this.db.handle
      .prepare(
        `${SELECT_MEMORY} WHERE state = 'active' ORDER BY importance DESC, updated_at DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(limit, 500)));

    return rows.map((row) => this.mapRow(row as Record<string, unknown>));
  }

  /** Everything ever recorded under one key, newest first. */
  listHistory(category: MemoryCategory, key: string): StoredMemory[] {
    const normalized = normalizeKey(key);

    if (normalized.length === 0) {
      return [];
    }

    const rows = this.db.handle
      .prepare(
        `${SELECT_MEMORY} WHERE category = ? AND key = ? ORDER BY updated_at DESC, id DESC`,
      )
      .all(category, normalized);

    return rows.map((row) => this.mapRow(row as Record<string, unknown>));
  }

  /** Soft delete: hidden from active lists, row kept for provenance. */
  archive(id: number): boolean {
    const result = this.db.handle
      .prepare(
        "UPDATE memories SET state = 'archived', updated_at = ? WHERE id = ? AND state = 'active'",
      )
      .run(Date.now(), id);

    return Number(result.changes) > 0;
  }

  /** Hard delete: the row is gone completely, history included. */
  forget(id: number): boolean {
    const result = this.db.handle
      .prepare("DELETE FROM memories WHERE id = ?")
      .run(id);

    return Number(result.changes) > 0;
  }

  countActive(): number {
    const row = this.db.handle
      .prepare("SELECT COUNT(*) AS count FROM memories WHERE state = 'active'")
      .get();

    return Number(row?.count ?? 0);
  }

  private insertActive(
    category: MemoryCategory,
    key: string,
    content: string,
    importance: number,
    sourceIds: number[],
  ): StoredMemory {
    const now = Date.now();

    const result = this.db.handle
      .prepare(
        "INSERT INTO memories (category, key, content, importance, state, source_message_ids, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)",
      )
      .run(
        category,
        key,
        content,
        importance,
        JSON.stringify(sourceIds),
        now,
        now,
      );

    return {
      id: Number(result.lastInsertRowid),
      category,
      key,
      content,
      importance,
      state: "active",
      sourceMessageIds: sourceIds,
      createdAt: now,
      updatedAt: now,
      lastConfirmedAt: null,
      expiresAt: null,
    };
  }

  private confirm(
    existing: StoredMemory,
    content: string,
    importance: number,
    sourceIds: number[],
  ): StoredMemory {
    const now = Date.now();

    const mergedIds = [
      ...new Set([...existing.sourceMessageIds, ...sourceIds]),
    ].slice(0, MAX_SOURCE_IDS);

    const nextImportance = Math.max(existing.importance, importance);

    this.db.handle
      .prepare(
        "UPDATE memories SET content = ?, importance = ?, source_message_ids = ?, last_confirmed_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        content,
        nextImportance,
        JSON.stringify(mergedIds),
        now,
        now,
        existing.id,
      );

    return {
      ...existing,
      content,
      importance: nextImportance,
      sourceMessageIds: mergedIds,
      updatedAt: now,
      lastConfirmedAt: now,
    };
  }

  private supersedeAndInsert(
    oldId: number,
    category: MemoryCategory,
    key: string,
    content: string,
    importance: number,
    sourceIds: number[],
  ): StoredMemory {
    return this.db.withTransaction(() => {
      const now = Date.now();

      const demoted = this.db.handle
        .prepare(
          "UPDATE memories SET state = 'superseded', updated_at = ? WHERE id = ? AND state = 'active'",
        )
        .run(now, oldId);

      if (Number(demoted.changes) === 0) {
        throw new Error(
          `Active memory ${oldId} disappeared before it could be superseded.`,
        );
      }

      return this.insertActive(category, key, content, importance, sourceIds);
    });
  }

  private mapRow(row: Record<string, unknown>): StoredMemory {
    return {
      id: Number(row.id),
      category: row.category as MemoryCategory,
      key: String(row.key),
      content: String(row.content),
      importance: Number(row.importance),
      state: row.state as MemoryState,
      sourceMessageIds: parseSourceIds(row.source_message_ids),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      lastConfirmedAt:
        row.last_confirmed_at === null ? null : Number(row.last_confirmed_at),
      expiresAt: row.expires_at === null ? null : Number(row.expires_at),
    };
  }
}
