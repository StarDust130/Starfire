import type { MemoryDatabase } from "./database.js";

import type { MemoryCategory } from "./memories.js";

import { redactSecrets } from "./redaction.js";

/*
 * Context Engine Phase 1 — local SQLite search over saved memories
 * and past conversations.
 *
 * Design:
 * - Token AND-search: every meaningful query token must appear in a
 *   row, so results stay relevant. Ranking: memories by importance
 *   then recency; messages by recency.
 * - Visibility rules: only ACTIVE memories (archived/superseded are
 *   invisible) and only COMPLETE message turns (interrupted are
 *   invisible).
 * - Privacy: message content is redacted in results — a search must
 *   never surface a secret from an old transcript.
 * - SQL-level exclusions (excludeKeys / excludeMessageIds) let the
 *   Context Builder remove Core-Memory duplicates and live-session
 *   turns INSIDE the query, so crowded-out results cannot happen.
 * - Pure SQLite: no embeddings, no model calls, sub-millisecond at
 *   companion scale. FTS5/vector search can replace the internals
 *   later without changing this public API.
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
  /** Memory keys to exclude (e.g. everything Core Memory already carries). */
  excludeKeys?: ReadonlySet<string>;
  /** Message row ids to exclude (e.g. the live conversation's turns). */
  excludeMessageIds?: ReadonlySet<number>;
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
      memories: this.searchMemoriesByTokens(
        tokens,
        clampLimit(options.limitMemories, SEARCH_MAX_MEMORIES),
        options.excludeKeys,
      ),
      messages: this.searchMessagesByTokens(
        tokens,
        clampLimit(options.limitMessages, SEARCH_MAX_MESSAGES),
        options.excludeMessageIds,
      ),
    };
  }

  searchMemories(query: string, limit?: number): MemorySearchHit[] {
    const tokens = normalizeSearchQuery(query);

    if (tokens.length === 0) {
      return [];
    }

    return this.searchMemoriesByTokens(
      tokens,
      clampLimit(limit, SEARCH_MAX_MEMORIES),
    );
  }

  searchMessages(query: string, limit?: number): MessageSearchHit[] {
    const tokens = normalizeSearchQuery(query);

    if (tokens.length === 0) {
      return [];
    }

    return this.searchMessagesByTokens(
      tokens,
      clampLimit(limit, SEARCH_MAX_MESSAGES),
    );
  }

  private searchMemoriesByTokens(
    tokens: readonly string[],
    limit: number,
    excludeKeys?: ReadonlySet<string>,
  ): MemorySearchHit[] {
    const clauses = tokens.map(
      () => "(content LIKE ? ESCAPE '\\' OR key LIKE ? ESCAPE '\\')",
    );

    const params: string[] = [];

    for (const token of tokens) {
      const pattern = `%${escapeLikePattern(token)}%`;

      params.push(pattern, pattern);
    }

    let sql = `SELECT id, category, key, content, importance, updated_at
         FROM memories
         WHERE state = 'active' AND ${clauses.join(" AND ")}`;

    if (excludeKeys && excludeKeys.size > 0) {
      const placeholders = [...excludeKeys].map(() => "?").join(", ");

      sql += ` AND key NOT IN (${placeholders})`;

      params.push(...excludeKeys);
    }

    sql += " ORDER BY importance DESC, updated_at DESC LIMIT ?";

    const rows = this.db.handle.prepare(sql).all(...params, limit);

    return (rows as Array<Record<string, unknown>>).map((row) => ({
      id: Number(row.id),
      category: row.category as MemoryCategory,
      key: String(row.key),
      content: String(row.content),
      importance: Number(row.importance),
      updatedAt: Number(row.updated_at),
    }));
  }

  private searchMessagesByTokens(
    tokens: readonly string[],
    limit: number,
    excludeMessageIds?: ReadonlySet<number>,
  ): MessageSearchHit[] {
    const clauses = tokens.map(() => "content LIKE ? ESCAPE '\\'");

    const params: Array<string | number> = tokens.map(
      (token) => `%${escapeLikePattern(token)}%`,
    );

    let sql = `SELECT id, session_id, role, content, created_at
         FROM messages
         WHERE interrupted = 0 AND ${clauses.join(" AND ")}`;

    if (excludeMessageIds && excludeMessageIds.size > 0) {
      const placeholders = [...excludeMessageIds].map(() => "?").join(", ");

      sql += ` AND id NOT IN (${placeholders})`;

      params.push(...excludeMessageIds);
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
