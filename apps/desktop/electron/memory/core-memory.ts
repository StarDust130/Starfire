import type { MemoryStore, StoredMemory } from "./memories.js";

/*
 * Core Memory — a tiny DERIVED profile built fresh from the canonical
 * active memory rows. It is NOT a second truth source: if the
 * memories table is empty, Core Memory is empty.
 *
 * Injected once per realtime session (every connect/reconnect) so a
 * fresh session starts knowing the user. Reading ~20 rows from SQLite
 * on the connect path is sub-millisecond and never touches the audio
 * path.
 */

export const CORE_MEMORY_MAX_MEMORIES = 20;

export const CORE_MEMORY_MAX_CHARS = 1_200;

const HEADER =
  "LONG-TERM MEMORY about the user (learned in past conversations — treat it as true, use it naturally, never claim you cannot remember):";

/**
 * Formats memories best-first (importance, then recency) into a
 * compact bullet block, hard-capped by char budget. Returns "" when
 * there is nothing worth injecting.
 */
export function formatCoreMemory(memories: readonly StoredMemory[]): string {
  const ordered = [...memories]
    .sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt)
    .slice(0, CORE_MEMORY_MAX_MEMORIES);

  if (ordered.length === 0) {
    return "";
  }

  const lines: string[] = [];

  let total = HEADER.length;

  for (const memory of ordered) {
    const line = `- ${memory.content}`;

    if (total + line.length > CORE_MEMORY_MAX_CHARS) {
      break;
    }

    lines.push(line);

    total += line.length;
  }

  if (lines.length === 0) {
    return "";
  }

  return `${HEADER}\n${lines.join("\n")}`;
}

/**
 * Thin read facade used by the realtime bridge. Never throws — a
 * database problem must degrade to "no injected memory", never break
 * voice.
 */
export class CoreMemoryProvider {
  constructor(private readonly store: MemoryStore | null) {}

  get(): string {
    if (!this.store) {
      return "";
    }

    try {
      return formatCoreMemory(this.store.listActive(CORE_MEMORY_MAX_MEMORIES));
    } catch (error) {
      console.warn(
        "[Memory] ⚠️ core memory read failed:",
        error instanceof Error ? error.message : error,
      );

      return "";
    }
  }
}
