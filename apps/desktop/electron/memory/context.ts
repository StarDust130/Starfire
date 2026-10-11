import { CORE_MEMORY_MAX_MEMORIES } from "./core-memory.js";

import type { MemoryStore } from "./memories.js";

import type {
  MemorySearch,
  MemorySearchHit,
  MessageSearchHit,
} from "./search.js";

/*
 * Context Engine Phase 2 — the selector.
 *
 * Decides what Starfire is TOLD about the past, beyond what she
 * already has:
 * - Core Memory dedupe: the top active memories injected at session
 *   start are excluded IN SQL by key — never repeated here.
 * - Live-conversation dedupe: current-session message ids can be
 *   excluded IN SQL — the realtime model already holds them.
 * - Strict budget: the block is hard-capped; nothing partial is sent.
 * - Privacy: message hits are redacted by MemorySearch; memory hits
 *   echoing redaction placeholders are dropped defensively.
 * - Never throws: build() degrades to "" on any failure, like
 *   CoreMemoryProvider.
 */

export const CONTEXT_MAX_CHARS = 1_500;

export const CONTEXT_MAX_MEMORIES = 4;

export const CONTEXT_MAX_MESSAGES = 4;

const HEADER =
  "RELEVANT MEMORY (from BEFORE this conversation — use it naturally, never recite it):";

const FACTS_HEADER = "Saved facts:";

const CHAT_HEADER = "From past chats:";

export type ContextBuildOptions = {
  /** Message row ids already visible in the live conversation. */
  excludeMessageIds?: ReadonlySet<number>;
};

export type SelectedContext = {
  memories: MemorySearchHit[];
  messages: MessageSearchHit[];
};

/**
 * Pure formatter: joins selected hits under a hard char budget,
 * keeping complete lines and dropping dangling section headers.
 */
export function formatRelevantContext(
  selected: SelectedContext,
  maxChars: number = CONTEXT_MAX_CHARS,
): string {
  if (selected.memories.length === 0 && selected.messages.length === 0) {
    return "";
  }

  const candidates: string[] = [HEADER];

  if (selected.memories.length > 0) {
    candidates.push(FACTS_HEADER);

    for (const hit of selected.memories) {
      candidates.push(`- ${hit.content}`);
    }
  }

  if (selected.messages.length > 0) {
    candidates.push(CHAT_HEADER);

    for (const hit of selected.messages) {
      candidates.push(`- (${hit.role}) ${hit.content}`);
    }
  }

  const kept: string[] = [];

  let total = 0;

  for (const line of candidates) {
    const cost = line.length + (kept.length > 0 ? 1 : 0);

    if (total + cost > maxChars) {
      break;
    }

    kept.push(line);

    total += cost;
  }

  // A section header with none of its lines kept is dangling — drop it.
  while (
    kept.length > 1 &&
    (kept[kept.length - 1] === FACTS_HEADER ||
      kept[kept.length - 1] === CHAT_HEADER)
  ) {
    kept.pop();
  }

  // Only the header survived (or nothing) — nothing useful to inject.
  if (kept.length <= 1) {
    return "";
  }

  return kept.join("\n");
}

export class ContextBuilder {
  constructor(
    private readonly memories: MemoryStore,
    private readonly search: MemorySearch,
  ) {}

  /**
   * Picks the hits Starfire does NOT already have: Core-Memory keys
   * and live-session message ids are excluded inside the SQL query.
   */
  select(query: string, options: ContextBuildOptions = {}): SelectedContext {
    const coreKeys = new Set(
      this.memories
        .listActive(CORE_MEMORY_MAX_MEMORIES)
        .map((memory) => memory.key),
    );

    const result = this.search.search(query, {
      limitMemories: CONTEXT_MAX_MEMORIES,
      limitMessages: CONTEXT_MAX_MESSAGES,
      excludeKeys: coreKeys,
      excludeMessageIds: options.excludeMessageIds,
    });

    const memories = result.memories.filter(
      (hit) => !/\[REDACTED:/i.test(hit.content),
    );

    return { memories, messages: result.messages };
  }

  /** The compact block for the model — "" when nothing is relevant. */
  build(query: string, options: ContextBuildOptions = {}): string {
    try {
      return formatRelevantContext(this.select(query, options));
    } catch (error) {
      console.warn(
        "[Memory] ⚠️ context build failed:",
        error instanceof Error ? error.message : error,
      );

      return "";
    }
  }
}

export const NO_MEMORY_RESULTS_MESSAGE = "No relevant memories found.";

/**
 * The exact string the model receives from a memory_search call:
 * the context block, or an honest "nothing found" — never "".
 */
export function formatMemorySearchResult(block: string): string {
  return block.trim().length > 0 ? block : NO_MEMORY_RESULTS_MESSAGE;
}
