import type { MemoryDatabase } from "./database.js";

/*
 * Durable conversation transcript. One row per complete turn.
 *
 * turn_index is allocated per session (0,1,2,...) inside a transaction,
 * and the (session_id, turn_index, role) unique index makes a replayed
 * INSERT a harmless no-op instead of a duplicate.
 *
 * Replayed EVENTS (the provider delivering the same completed
 * transcription twice) allocate a NEW turn_index, so the unique index
 * cannot catch them — insertTurn therefore also rejects an identical
 * (session, role, content) row recorded within DUPLICATE_WINDOW_MS.
 * Legitimate repeats are safe: "Okay. Bye. Bye." is ONE transcript
 * event, and real repeats spaced wider than the window store normally.
 *
 * interrupted=1 rows are kept for provenance but are never eligible
 * for memory extraction (see listUnprocessed).
 */

export type StoredRole = "user" | "assistant";

export const MAX_MESSAGE_CHARS = 8_000;

export const DUPLICATE_WINDOW_MS = 1_000;

export type InsertTurnInput = {
  sessionId: string;
  role: StoredRole;
  content: string;
  interrupted?: boolean;
};

export type StoredTurn = {
  id: number;
  sessionId: string;
  turnIndex: number;
  role: StoredRole;
  content: string;
  interrupted: boolean;
  createdAt: number;
};

export class MessageStore {
  constructor(private readonly db: MemoryDatabase) {}

  /**
   * `now` is injectable for tests; production callers use the default.
   */
  insertTurn(
    input: InsertTurnInput,
    now: number = Date.now(),
    /**
     * Time-window replay fallback. Providers WITHOUT stable event ids
     * need it; providers WITH ids should pass false so legitimate
     * identical utterances spoken quickly are never dropped.
     */
    dedupeWindow = true,
  ): { id: number; turnIndex: number } | null {
    const content = input.content.trim();

    if (content.length === 0) {
      return null;
    }

    const safeContent = content.slice(0, MAX_MESSAGE_CHARS);

    return this.db.withTransaction(() => {
      const recent = this.db.handle
        .prepare(
          "SELECT role, content, created_at FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 1",
        )
        .get(input.sessionId);

      const isReplay =
        dedupeWindow &&
        recent !== undefined &&
        String(recent.role) === input.role &&
        String(recent.content) === safeContent &&
        now - Number(recent.created_at) < DUPLICATE_WINDOW_MS;

      if (isReplay) {
        return null;
      }

      const row = this.db.handle
        .prepare(
          "SELECT COALESCE(MAX(turn_index) + 1, 0) AS next FROM messages WHERE session_id = ?",
        )
        .get(input.sessionId);

      const turnIndex = Number(row?.next ?? 0);

      try {
        const result = this.db.handle
          .prepare(
            "INSERT INTO messages (session_id, turn_index, role, content, interrupted, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(
            input.sessionId,
            turnIndex,
            input.role,
            safeContent,
            input.interrupted ? 1 : 0,
            now,
          );

        return { id: Number(result.lastInsertRowid), turnIndex };
      } catch (error) {
        if (
          error instanceof Error &&
          /UNIQUE constraint/i.test(error.message)
        ) {
          return null;
        }

        throw error;
      }
    });
  }

  listSessionTurns(sessionId: string): StoredTurn[] {
    const rows = this.db.handle
      .prepare(
        "SELECT id, session_id, turn_index, role, content, interrupted, created_at FROM messages WHERE session_id = ? ORDER BY id",
      )
      .all(sessionId);

    return rows.map((row) => this.mapRow(row as Record<string, unknown>));
  }

  /**
   * Complete, non-interrupted turns not yet handed to extraction.
   * The job queue consumes this in batches.
   */
  listUnprocessed(limit: number): StoredTurn[] {
    const rows = this.db.handle
      .prepare(
        "SELECT id, session_id, turn_index, role, content, interrupted, created_at FROM messages WHERE processed_at IS NULL AND interrupted = 0 ORDER BY id LIMIT ?",
      )
      .all(limit);

    return rows.map((row) => this.mapRow(row as Record<string, unknown>));
  }

  markProcessed(ids: number[]): void {
    if (ids.length === 0) {
      return;
    }

    const placeholders = ids.map(() => "?").join(", ");

    this.db.handle
      .prepare(
        `UPDATE messages SET processed_at = ? WHERE id IN (${placeholders}) AND processed_at IS NULL`,
      )
      .run(Date.now(), ...ids);
  }

  countUnprocessed(): number {
    const row = this.db.handle
      .prepare(
        "SELECT COUNT(*) AS count FROM messages WHERE processed_at IS NULL AND interrupted = 0",
      )
      .get();

    return Number(row?.count ?? 0);
  }

  /** Fetches specific turns by id, in id order (queue job payloads). */
  getTurnsByIds(ids: number[]): StoredTurn[] {
    if (ids.length === 0) {
      return [];
    }

    const placeholders = ids.map(() => "?").join(", ");

    const rows = this.db.handle
      .prepare(
        `SELECT id, session_id, turn_index, role, content, interrupted, created_at FROM messages WHERE id IN (${placeholders}) ORDER BY id`,
      )
      .all(...ids);

    return rows.map((row) => this.mapRow(row as Record<string, unknown>));
  }

  /** The `limit` turns immediately before `beforeId` (oldest first). */
  listRecentBefore(beforeId: number, limit: number): StoredTurn[] {
    const rows = this.db.handle
      .prepare(
        "SELECT id, session_id, turn_index, role, content, interrupted, created_at FROM messages WHERE id < ? ORDER BY id DESC LIMIT ?",
      )
      .all(beforeId, Math.max(1, limit));

    return rows
      .map((row) => this.mapRow(row as Record<string, unknown>))
      .reverse();
  }

  /**
   * The most recent complete turns across ALL sessions (oldest
   * first), optionally excluding one session (the live one — the
   * model already holds it). Used by continuity restoration.
   */
  listRecentTurns(limit: number, excludeSessionId?: string): StoredTurn[] {
    const capped = Math.max(1, Math.min(limit, 50));

    const rows = excludeSessionId
      ? this.db.handle
          .prepare(
            "SELECT id, session_id, turn_index, role, content, interrupted, created_at FROM messages WHERE interrupted = 0 AND session_id != ? ORDER BY id DESC LIMIT ?",
          )
          .all(excludeSessionId, capped)
      : this.db.handle
          .prepare(
            "SELECT id, session_id, turn_index, role, content, interrupted, created_at FROM messages WHERE interrupted = 0 ORDER BY id DESC LIMIT ?",
          )
          .all(capped);

    return (rows as Array<Record<string, unknown>>)
      .map((row) => this.mapRow(row))
      .reverse();
  }

  private mapRow(row: Record<string, unknown>): StoredTurn {
    return {
      id: Number(row.id),
      sessionId: String(row.session_id),
      turnIndex: Number(row.turn_index),
      role: row.role === "assistant" ? "assistant" : "user",
      content: String(row.content),
      interrupted: Number(row.interrupted) === 1,
      createdAt: Number(row.created_at),
    };
  }
}
