import type { MemoryDatabase } from "./database.js";

/*
 * Durable conversation transcript. One row per complete turn.
 *
 * turn_index is allocated per session (0,1,2,...) inside a transaction,
 * and the (session_id, turn_index, role) unique index turns a replayed
 * insert into a harmless no-op instead of a duplicate.
 *
 * interrupted=1 rows are kept for provenance but are never eligible
 * for memory extraction (see listUnprocessed).
 */

export type StoredRole = "user" | "assistant";

export const MAX_MESSAGE_CHARS = 8_000;

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

  insertTurn(input: InsertTurnInput): { id: number; turnIndex: number } | null {
    const content = input.content.trim();

    if (content.length === 0) {
      return null;
    }

    const safeContent = content.slice(0, MAX_MESSAGE_CHARS);

    return this.db.withTransaction(() => {
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
            Date.now(),
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
   * Piece 4 (job queue) will consume this in batches.
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
