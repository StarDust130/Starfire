import type { MemoryDatabase } from "./database.js";

import type { MemoryCategory } from "./memories.js";

import { redactSecrets } from "./redaction.js";

/*
 * Context Engine Phase 1 — local SQLite search over saved memories
 * and past conversations.
 *
 * Design:
 * - Token AND-search: every meaningful query token must appear in a
 *   row. Ranking: memories by importance then recency; messages by
 *   recency.
 * - Visibility: only ACTIVE memories; only COMPLETE message turns.
 * - Privacy: BOTH memory and message results are redacted on read —
 *   search must never surface a secret, including legacy rows.
 * - SQL-level exclusions (ids / sessions) let callers remove exactly
 *   what a specific model already has, inside the query.
 * - Pure SQLite: no embeddings, no model calls. FTS5/vector search can
 *   replace the internals later without changing this public API.
 */

export const SEARCH_MAX_MEMORIES = 5;

export const SEARCH_MAX_MESSAGES = 5;

export const SEARCH_MAX_LIMIT = 20;

export const SEARCH_MAX_TOKENS = 8;

export const SEARCH_MAX_TOKEN_CHARS = 60;

export const SEARCH_SNIPPET_CHARS = 300;

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "am",
  "do",
  "does",
  "did",
  "done",
  "i",
  "im",
  "me",
  "my",
  "mine",
  "we",
  "our",
  "you",
  "your",
  "yours",
  "he",
  "she",
  "it",
  "its",
  "they",
  "them",
  "their",
  "what",
  "when",
  "where",
  "who",
  "whom",
  "which",
  "why",
  "how",
  "say",
  "said",
  "says",
  "tell",
  "told",
  "ask",
  "asked",
  "know",
  "knew",
  "remember",
  "remembers",
  "about",
  "of",
  "in",
  "on",
  "at",
  "to",
  "for",
  "with",
  "from",
  "by",
  "and",
  "or",
  "but",
  "so",
  "that",
  "this",
  "these",
  "those",
  "there",
  "here",
  "can",
  "could",
  "would",
  "should",
  "will",
  "shall",
  "may",
  "might",
  "must",
  "have",
  "has",
  "had",
  "if",
  "then",
  "than",
  "as",
  "not",
  "no",
  "yes",
]);

export type MemorySearchHit = {
  id: number;
  category: MemoryCategory;
  key: string;
  /** Redacted on read — safe to hand to a model. */
  content: string;
  importance: number;
  updatedAt: number;
};

export type MessageSearchHit = {
  id: number;
  sessionId: string;
  role: "user" | "assistant";
  /** Redacted and snippet-capped — safe to hand to a model. */
  content: string;
  createdAt: number;
};

export type MemorySearchResult = {
  query: string;
  tokens: string[];
  memories: MemorySearchHit[];
  messages: MessageSearchHit[];
};

export type MemorySearchOptions = {
  limitMemories?: number;
  limitMessages?: number;
  /** Exact memory row ids to exclude (e.g. what Core Memory injected). */
  excludeMemoryIds?: ReadonlySet<number>;
  /** Message row ids to exclude. */
  excludeMessageIds?: ReadonlySet<number>;
  /**
   * Whole sessions to exclude (e.g. the live voice conversation).
   * Immune to SQLite variable limits no matter how long a session
   * grows — unlike per-id exclusion.
   */
  excludeSessionIds?: ReadonlySet<string>;
};

export function normalizeSearchQuery(raw: string): string[] {
  if (typeof raw !== "string") {
    return [];
  }

  const tokens = raw
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(
      (token) =>
        token.length > 0 &&
        token.length <= SEARCH_MAX_TOKEN_CHARS &&
        !STOPWORDS.has(token),
    );

  return [...new Set(tokens)].slice(0, SEARCH_MAX_TOKENS);
}

function escapeLikePattern(token: string): string {
  /*
   * Defense in depth: tokens from normalizeSearchQuery cannot contain
   * wildcards, but LIKE patterns must never be wildcard-shaped.
   */
  return token.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function clampLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(SEARCH_MAX_LIMIT, Math.max(1, Math.round(value)));
}

/** Compact window around the first token match, for bounded results. */
function snippetAround(content: string, tokens: readonly string[]): string {
  if (content.length <= SEARCH_SNIPPET_CHARS) {
    return content;
  }

  const lower = content.toLowerCase();

  let firstIndex = -1;

  for (const token of tokens) {
    const index = lower.indexOf(token);

    if (index !== -1 && (firstIndex === -1 || index < firstIndex)) {
      firstIndex = index;
    }
  }

  const start = Math.max(0, (firstIndex === -1 ? 0 : firstIndex) - 80);

  const end = Math.min(content.length, start + SEARCH_SNIPPET_CHARS);

  const prefix = start > 0 ? "…" : "";

  const suffix = end < content.length ? "…" : "";

  return `${prefix}${content.slice(start, end)}${suffix}`;
}

function notInClause(column: string, size: number): string {
  return ` AND ${column} NOT IN (${[...Array(size)].map(() => "?").join(", ")})`;
}

export class MemorySearch {
  constructor(private readonly db: MemoryDatabase) {}

  /** Both sources at once — the Context Builder's main entry point. */
  search(query: string, options: MemorySearchOptions = {}): MemorySearchResult {
    const tokens = normalizeSearchQuery(query);

    if (tokens.length === 0) {
      return { query, tokens, memories: [], messages: [] };
    }

    return {
      query,
      tokens,
      memories: this.searchMemoriesByTokens(tokens, options),
      messages: this.searchMessagesByTokens(tokens, options),
    };
  }

  searchMemories(query: string, limit?: number): MemorySearchHit[] {
    const tokens = normalizeSearchQuery(query);

    if (tokens.length === 0) {
      return [];
    }

    return this.searchMemoriesByTokens(tokens, {
      limitMemories: limit,
    });
  }

  searchMessages(query: string, limit?: number): MessageSearchHit[] {
    const tokens = normalizeSearchQuery(query);

    if (tokens.length === 0) {
      return [];
    }

    return this.searchMessagesByTokens(tokens, {
      limitMessages: limit,
    });
  }

  private searchMemoriesByTokens(
    tokens: readonly string[],
    options: MemorySearchOptions,
  ): MemorySearchHit[] {
    const limit = clampLimit(options.limitMemories, SEARCH_MAX_MEMORIES);

    const clauses = tokens.map(
      () => "(content LIKE ? ESCAPE '\\' OR key LIKE ? ESCAPE '\\')",
    );

    const params: Array<string | number> = [];

    for (const token of tokens) {
      const pattern = `%${escapeLikePattern(token)}%`;

      params.push(pattern, pattern);
    }

    let sql = `SELECT id, category, key, content, importance, updated_at
         FROM memories
         WHERE state = 'active' AND ${clauses.join(" AND ")}`;

    const excludeMemoryIds = options.excludeMemoryIds;

    if (excludeMemoryIds && excludeMemoryIds.size > 0) {
      sql += notInClause("id", excludeMemoryIds.size);

      params.push(...excludeMemoryIds);
    }

    sql += " ORDER BY importance DESC, updated_at DESC LIMIT ?";

    const rows = this.db.handle.prepare(sql).all(...params, limit);

    return (rows as Array<Record<string, unknown>>).map((row) => ({
      id: Number(row.id),
      category: row.category as MemoryCategory,
      key: String(row.key),
      content: redactSecrets(String(row.content)).text,
      importance: Number(row.importance),
      updatedAt: Number(row.updated_at),
    }));
  }

  private searchMessagesByTokens(
    tokens: readonly string[],
    options: MemorySearchOptions,
  ): MessageSearchHit[] {
    const limit = clampLimit(options.limitMessages, SEARCH_MAX_MESSAGES);

    const clauses = tokens.map(() => "content LIKE ? ESCAPE '\\'");

    const params: Array<string | number> = tokens.map(
      (token) => `%${escapeLikePattern(token)}%`,
    );

    let sql = `SELECT id, session_id, role, content, created_at
         FROM messages
         WHERE interrupted = 0 AND ${clauses.join(" AND ")}`;

    const excludeMessageIds = options.excludeMessageIds;

    if (excludeMessageIds && excludeMessageIds.size > 0) {
      sql += notInClause("id", excludeMessageIds.size);

      params.push(...excludeMessageIds);
    }

    const excludeSessionIds = options.excludeSessionIds;

    if (excludeSessionIds && excludeSessionIds.size > 0) {
      sql += notInClause("session_id", excludeSessionIds.size);

      params.push(...excludeSessionIds);
    }

    sql += " ORDER BY id DESC LIMIT ?";

    const rows = this.db.handle.prepare(sql).all(...params, limit);

    return (rows as Array<Record<string, unknown>>).map((row) => {
      const redacted = redactSecrets(String(row.content)).text;

      return {
        id: Number(row.id),
        sessionId: String(row.session_id),
        role: row.role === "assistant" ? "assistant" : "user",
        content: snippetAround(redacted, tokens),
        createdAt: Number(row.created_at),
      };
    });
  }
}
