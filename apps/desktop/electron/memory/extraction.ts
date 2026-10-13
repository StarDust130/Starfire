import { z } from "zod";
import type { MemoryCategory } from "./memories.js";
import {
  MAX_MEMORY_CHARS,
  MAX_SOURCE_IDS,
  MEMORY_CATEGORIES,
  normalizeKey,
} from "./memories.js";
import { ExtractionRateLimiter, estimateTokens } from "./rate-limit.js";
import { redactSecrets, redactTurns } from "./redaction.js";

/*
 * GLM extraction provider with model fallback — the ONLY place
 * Starfire talks to a cloud model about memories. Pure: turns in ->
 * drafts out. No database access, no queue access; the orchestrator
 * owns those.
 *
 * Provider details (official model docs + live verification):
 * POST {baseUrl}/chat/completions, bearer key, JSON mode via
 * response_format, thinking disabled, no tools/web search.
 *
 * FALLBACK RULES (account-wide limits make these critical):
 * - Primary: config.model (glm-4-7-flash).
 * - Fallback: config.fallbackModel (qwen3-5-4b) ONLY for
 *   server/timeout/network/malformed failures — cases where a
 *   different model can plausibly succeed.
 * - 429 = ACCOUNT-WIDE shared quota: NEVER fallback (the backup hits
 *   the same exhausted quota). Cooldown + retry later instead.
 * - auth/client/disabled: configuration problems — fallback cannot
 *   help; fail fast without burning attempts.
 * - The same strict parser, provenance map, and redaction apply to
 *   both models. Success metadata records WHICH model produced it.
 */

export const DEFAULT_MEMORY_BASE_URL = "https://api.empiriolabs.ai/v1";
export const DEFAULT_MEMORY_MODEL = "glm-4-7-flash";
export const DEFAULT_MEMORY_FALLBACK_MODEL = "qwen3-5-4b";

/*
 * The free tier is SHARED across users — observed 429s occur well
 * below the documented 50/min. Stay conservative: 20/min with a 3s
 * minimum gap, and honor Retry-After with a global cooldown.
 */
export const DEFAULT_MAX_REQUESTS_PER_MINUTE = 20;
export const DEFAULT_MAX_TOKENS_PER_MINUTE = 1_600_000;
export const DEFAULT_MIN_INTERVAL_MS = 3_000;
export const DEFAULT_EXTRACTION_TIMEOUT_MS = 45_000;
export const EXTRACTION_MAX_OUTPUT_TOKENS = 2_000;
export const EXTRACTION_MAX_DRAFTS = 12;
export const EXTRACTION_CONTEXT_TURNS = 12;
export const CONTEXT_TURN_MAX_CHARS = 400;
export const RATE_LIMIT_FALLBACK_MS = 60_000;
export const RETRY_AFTER_MAX_MS = 600_000;

export type ExtractionTurn = {
  id: number;
  role: "user" | "assistant";
  content: string;
};

export type ExtractedMemoryDraft = {
  category: MemoryCategory;
  key: string;
  content: string;
  importance: number;
  sourceMessageIds: number[];
};

export type ExtractionSuccess = {
  ok: true;
  empty: boolean;
  drafts: ExtractedMemoryDraft[];
  usage: { inputTokens: number; outputTokens: number } | null;
  redactions: string[];
  /** Which model actually produced this result (safe metadata). */
  model: string;
};

export type ExtractionFailureKind =
  | "disabled"
  | "auth"
  | "client"
  | "rate_limited"
  | "server"
  | "network"
  | "timeout"
  | "malformed";

export type ExtractionFailure = {
  ok: false;
  kind: ExtractionFailureKind;
  retryable: boolean;
  retryAfterMs: number | null;
  message: string;
};

export type ExtractionResult = ExtractionSuccess | ExtractionFailure;

export type ExtractionConfig = {
  enabled: boolean;
  apiKey: string | null;
  baseUrl: string;
  model: string;
  /** Fallback model, or null to disable fallback ("none" in env). */
  fallbackModel: string | null;
  maxRequestsPerMinute: number;
  maxTokensPerMinute: number;
  minIntervalMs: number;
  timeoutMs: number;
};

function isTruthy(value: string | undefined): boolean {
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

function numberEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveExtractionConfig(
  env: NodeJS.ProcessEnv = process.env,
): ExtractionConfig {
  const apiKey = env.STARFIRE_MEMORY_API_KEY?.trim() || null;

  const disabled =
    isTruthy(env.STARFIRE_MEMORY_CLOUD_DISABLED) ||
    isTruthy(env.STARFIRE_MEMORY_DISABLED);

  const fallbackRaw = env.STARFIRE_MEMORY_FALLBACK_MODEL?.trim();

  const fallbackModel =
    fallbackRaw === undefined || fallbackRaw === ""
      ? DEFAULT_MEMORY_FALLBACK_MODEL
      : fallbackRaw.toLowerCase() === "none"
        ? null
        : fallbackRaw;

  return {
    enabled: !disabled && apiKey !== null,
    apiKey,
    baseUrl: env.STARFIRE_MEMORY_BASE_URL?.trim() || DEFAULT_MEMORY_BASE_URL,
    model: env.STARFIRE_MEMORY_MODEL?.trim() || DEFAULT_MEMORY_MODEL,
    fallbackModel,
    maxRequestsPerMinute: numberEnv(
      env.STARFIRE_GLM_MAX_RPM,
      DEFAULT_MAX_REQUESTS_PER_MINUTE,
    ),
    maxTokensPerMinute: numberEnv(
      env.STARFIRE_GLM_MAX_TOKENS_PER_MINUTE,
      DEFAULT_MAX_TOKENS_PER_MINUTE,
    ),
    minIntervalMs: numberEnv(
      env.STARFIRE_GLM_MIN_INTERVAL_MS,
      DEFAULT_MIN_INTERVAL_MS,
    ),
    timeoutMs: numberEnv(
      env.STARFIRE_MEMORY_TIMEOUT_MS,
      DEFAULT_EXTRACTION_TIMEOUT_MS,
    ),
  };
}

const SYSTEM_PROMPT = `You are the memory-extraction engine inside Starfire, a personal desktop AI companion.
Your ONLY job: read the conversation excerpt and decide which DURABLE facts about the user are worth remembering long-term.

Return STRICT JSON, no prose, no markdown:
{"memories":[{"category":"<cat>","key":"<key>","content":"<content>","importance":<1-5>,"sourceMessageIds":[<ids>]}]}

CATEGORIES (exactly one per memory): profile, preference, goal, project, fact, event.

WHAT TO EXTRACT:
- profile: identity (name, job, city, languages, family)
- preference: likes/dislikes, tools, styles, food, music
- goal: ambitions and plans
- project: ongoing work the user is doing
- fact: stable facts that are not identity
- event: notable happenings worth recalling later

RULES:
1. Extract ONLY from NEW MESSAGES. The CONTEXT block and ALREADY-KNOWN MEMORIES exist to resolve pronouns/fragments and to avoid duplicates. Never extract from them, never invent facts.
2. Ignore small talk, greetings, news, weather, tool results, and anything transient.
3. NEVER store secrets or anything marked [REDACTED:...]. Treat redacted values as unknown.
4. key: short stable english identifier, lowercase, letters/digits/dots/dashes only (e.g. "user.name", "editor", "goal.career", "project.starfire"). Reuse the same key when a later message updates the same fact.
5. content: ONE concise sentence, third person, grounded ONLY in what was explicitly said. Keep the user's language for names and terms. Max ~200 chars.
6. importance: 5 = core identity or major goal, 4 = strong preference or project, 3 = normal fact, 2 = minor, 1 = trivia.
7. sourceMessageIds: the #ids of the NEW MESSAGES this fact came from, preferring USER messages. Every memory MUST cite at least one valid USER-message id — memories without one are discarded.
8. If two messages conflict, use the newest statement.
9. If nothing is worth remembering return {"memories":[]} — empty is CORRECT for most small talk.
10. At most 12 memories. Quality over quantity.
11. NEVER store absence or uncertainty as a fact ("not yet known", "hasn't said", "no information"). If a detail is missing or unclear, extract nothing for it.
12. NEVER invent derivations or connections that were not explicitly stated (e.g., what a name "means", why something happened).
13. Ignore garbled, fragmentary, or unintelligible transcriptions entirely — do not guess what was meant. A name-like fragment alone is NOT a name.
14. Tool results and assistant replies (weather, search, time, app actions) describe the WORLD, not the user. NEVER infer user attributes like location or city from them.
15. One greeting or single word in a language does NOT mean the user speaks that language. Record a language only if the user clearly converses in it.
16. When unsure, return fewer memories or none. A missed fact is better than a wrong one. Empty is always acceptable.
17. ALREADY-KNOWN MEMORIES are facts already saved. Do NOT restate them as new memories unless a NEW MESSAGE explicitly changes or extends one — then extract only the NEW value and cite the changing message id.

EXAMPLES:
- "hello" / "what's the weather?" / garbled audio -> {"memories":[]}
- "my name is Thor" -> {"memories":[{"category":"profile","key":"user.name","content":"The user's name is Thor.","importance":5,"sourceMessageIds":[<that id>]}]}`;

const CONTEXT_HEADER =
  "CONTEXT (older turns, READ-ONLY, for understanding only):";

const BATCH_HEADER = "NEW MESSAGES (extract durable memories ONLY from these):";

const FOOTER = "Now return ONLY the JSON object.";

function clampChars(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function buildExtractionMessages(input: {
  context: readonly ExtractionTurn[];
  batch: readonly ExtractionTurn[];
  existingMemories?: readonly string[];
}): { system: string; user: string } {
  const contextBlock = input.context
    .slice(-EXTRACTION_CONTEXT_TURNS)
    .map(
      (turn) =>
        `#${turn.id} ${turn.role}: ${clampChars(turn.content, CONTEXT_TURN_MAX_CHARS)}`,
    )
    .join("\n");

  const knownBlock = (input.existingMemories ?? [])
    .map((memory) => `- ${clampChars(memory, 160)}`)
    .join("\n");

  const batchBlock = input.batch
    .map((turn) => `#${turn.id} ${turn.role}: ${turn.content}`)
    .join("\n");

  const user = `${CONTEXT_HEADER}\n${contextBlock || "(none)"}\n\nALREADY-KNOWN MEMORIES (do not re-extract unless a NEW MESSAGE changes one):\n${knownBlock || "(none)"}\n\n${BATCH_HEADER}\n${batchBlock}\n\n${FOOTER}`;

  return { system: SYSTEM_PROMPT, user };
}

const draftSchema = z.object({
  category: z.enum(MEMORY_CATEGORIES),
  key: z.string().min(1).max(200),
  content: z.string().min(1),
  importance: z.coerce.number().optional(),
  sourceMessageIds: z.array(z.coerce.number().int().positive()).default([]),
});

/*
 * Backstop against absence-style non-facts ("the user's name is not
 * yet known"). Narrow on purpose so real negative facts survive.
 */
const ABSENCE_CONTENT_PATTERN =
  /\b(?:not yet (?:known|specified|decided|mentioned|provided|shared)|is unknown|are unknown|remains unknown|not specified|no information)\b/i;

function unwrapMemoriesArray(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const record = parsed as Record<string, unknown>;

  if (Array.isArray(record.memories)) {
    return record.memories;
  }

  for (const value of Object.values(record)) {
    if (
      typeof value === "object" &&
      value !== null &&
      Array.isArray((value as Record<string, unknown>).memories)
    ) {
      return (value as Record<string, unknown>).memories as unknown[];
    }
  }

  return null;
}

function clampImportance(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 3;
  }

  return Math.min(5, Math.max(1, Math.round(value)));
}

function extractJsonBlock(raw: string): string | null {
  const cleaned = raw.replace(/```(?:json)?/gi, "");

  const start = cleaned.indexOf("{");

  const end = cleaned.lastIndexOf("}");

  if (start === -1 || end <= start) {
    return null;
  }

  return cleaned.slice(start, end + 1);
}

export type ParsedPayload =
  | { ok: true; drafts: ExtractedMemoryDraft[] }
  | { ok: false; reason: string };

/**
 * Strict validation with TRUSTWORTHY PROVENANCE:
 * - a memories array must exist (possibly wrapped);
 * - individual bad items are dropped, never poisoning the batch;
 * - source ids must reference USER messages from the batch —
 *   assistant confirmations and foreign ids prove nothing;
 * - a draft with NO valid user-message source id is REJECTED;
 * - redaction placeholders and absence-style non-facts never store.
 */
export function parseExtractionPayload(
  raw: string,
  provenance: ReadonlyMap<number, "user" | "assistant">,
): ParsedPayload {
  const jsonText = extractJsonBlock(raw);

  if (!jsonText) {
    return { ok: false, reason: "no JSON object found in response" };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { ok: false, reason: "invalid JSON" };
  }

  const memories = unwrapMemoriesArray(parsed);

  if (memories === null) {
    return { ok: false, reason: "expected a memories array" };
  }

  const drafts: ExtractedMemoryDraft[] = [];

  for (const item of memories) {
    const checked = draftSchema.safeParse(item);

    if (!checked.success) {
      continue;
    }

    const key = normalizeKey(checked.data.key);

    const content = checked.data.content.trim().slice(0, MAX_MEMORY_CHARS);

    if (key.length === 0 || content.length === 0) {
      continue;
    }

    if (/\[REDACTED:/i.test(content)) {
      continue;
    }

    if (ABSENCE_CONTENT_PATTERN.test(content)) {
      continue;
    }

    const sourceIds = [
      ...new Set(
        checked.data.sourceMessageIds.filter(
          (id) => provenance.get(id) === "user",
        ),
      ),
    ].slice(0, MAX_SOURCE_IDS);

    if (sourceIds.length === 0) {
      continue;
    }

    drafts.push({
      category: checked.data.category,
      key,
      content,
      importance: clampImportance(checked.data.importance),
      sourceMessageIds: sourceIds,
    });

    if (drafts.length >= EXTRACTION_MAX_DRAFTS) {
      break;
    }
  }

  return { ok: true, drafts };
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function failure(
  kind: ExtractionFailureKind,
  retryable: boolean,
  retryAfterMs: number | null,
  message: string,
): ExtractionFailure {
  return { ok: false, kind, retryable, retryAfterMs, message };
}

/**
 * Retry-After units are inconsistent in the wild: HTTP says seconds,
 * but this provider sends milliseconds ("60000" = 60s). Heuristic:
 * values > 3600 are milliseconds; everything is clamped.
 */
export function parseRetryAfterMs(header: string | null): number | null {
  if (!header) {
    return null;
  }

  const value = Number(header.trim());

  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  const seconds = value > 3_600 ? value / 1_000 : value;

  const ms = Math.round(seconds * 1_000);

  return Math.min(RETRY_AFTER_MAX_MS, Math.max(1_000, ms));
}

function readChoiceContent(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const choices = (payload as Record<string, unknown>).choices;

  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }

  const first = choices[0];

  if (typeof first !== "object" || first === null) {
    return null;
  }

  const message = (first as Record<string, unknown>).message;

  if (typeof message !== "object" || message === null) {
    return null;
  }

  const content = (message as Record<string, unknown>).content;

  return typeof content === "string" ? content : null;
}

function readUsage(
  payload: unknown,
): { inputTokens: number; outputTokens: number } | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const usage = (payload as Record<string, unknown>).usage;

  if (typeof usage !== "object" || usage === null) {
    return null;
  }

  const record = usage as Record<string, unknown>;

  const input = record.prompt_tokens ?? record.input_tokens;

  const output = record.completion_tokens ?? record.output_tokens;

  if (typeof input !== "number" || typeof output !== "number") {
    return null;
  }

  return { inputTokens: input, outputTokens: output };
}

/** Failure kinds where a DIFFERENT model can plausibly succeed. */
function fallbackEligible(kind: ExtractionFailureKind): boolean {
  return (
    kind === "server" ||
    kind === "timeout" ||
    kind === "network" ||
    kind === "malformed"
  );
}

export class GlmExtractionProvider {
  private readonly limiter: ExtractionRateLimiter;

  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: ExtractionConfig,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly sleepFn: (ms: number) => Promise<void> = defaultSleep,
  ) {
    this.limiter = new ExtractionRateLimiter({
      maxRequestsPerMinute: config.maxRequestsPerMinute,
      maxTokensPerMinute: config.maxTokensPerMinute,
      minIntervalMs: config.minIntervalMs,
      sleep: this.sleepFn,
    });
  }

  isConfigured(): boolean {
    return this.config.enabled && this.config.apiKey !== null;
  }

  /**
   * Serialized: at most one request in flight, no matter who calls.
   * Each caller receives a promise for ITS OWN run.
   */
  extract(input: {
    context: readonly ExtractionTurn[];
    batch: readonly ExtractionTurn[];
    existingMemories?: readonly string[];
  }): Promise<ExtractionResult> {
    const next = (): Promise<ExtractionResult> => this.runOnce(input);

    const run = this.chain.then(next, next) as Promise<ExtractionResult>;

    this.chain = run;

    return run;
  }

  private async runOnce(input: {
    context: readonly ExtractionTurn[];
    batch: readonly ExtractionTurn[];
    existingMemories?: readonly string[];
  }): Promise<ExtractionResult> {
    if (!this.isConfigured()) {
      return failure(
        "disabled",
        false,
        null,
        "Extraction is not configured (missing API key or disabled).",
      );
    }

    // During a provider cooldown, fail fast WITHOUT touching the
    // network — retries and new jobs must not hammer an overloaded
    // service.
    const cooldownMs = this.limiter.remainingCooldownMs();

    if (cooldownMs > 0) {
      return failure(
        "rate_limited",
        true,
        cooldownMs,
        `Provider cooldown active for ${Math.round(cooldownMs / 1000)}s; skipping network call.`,
      );
    }

    const primary = await this.attempt(this.config.model, input);

    if (primary.ok) {
      return primary;
    }

    const fallbackModel = this.config.fallbackModel;

    const canFallback =
      typeof fallbackModel === "string" &&
      fallbackModel.length > 0 &&
      fallbackModel !== this.config.model &&
      fallbackEligible(primary.kind);

    if (!canFallback) {
      return primary;
    }

    console.log(
      `[Memory GLM] fallback to ${fallbackModel} (primary ${primary.kind})`,
    );

    const fallback = await this.attempt(fallbackModel, input);

    if (fallback.ok) {
      return fallback;
    }

    // Both models failed: preserve the job via the primary failure,
    // enriched with the fallback outcome (kinds only — no bodies).
    return failure(
      primary.kind,
      primary.retryable,
      primary.retryAfterMs,
      `primary ${primary.kind}; fallback ${fallback.kind}`,
    );
  }

  private async attempt(
    model: string,
    input: {
      context: readonly ExtractionTurn[];
      batch: readonly ExtractionTurn[];
      existingMemories?: readonly string[];
    },
  ): Promise<ExtractionResult> {
    // Provenance map: which batch ids exist, and which role spoke them.
    const provenance = new Map<number, "user" | "assistant">(
      input.batch.map((turn) => [turn.id, turn.role]),
    );

    const knownMemories = (input.existingMemories ?? []).map(
      (memory) => redactSecrets(memory).text,
    );

    const redactedBatch = redactTurns(input.batch);

    const redactedContext = redactTurns(input.context);

    const redactions = [
      ...new Set([...redactedBatch.redactions, ...redactedContext.redactions]),
    ];

    const { system, user } = buildExtractionMessages({
      context: redactedContext.turns,
      batch: redactedBatch.turns,
      existingMemories: knownMemories,
    });

    const estimatedTokens = estimateTokens(system.length + user.length);

    const body = JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.1,
      max_tokens: EXTRACTION_MAX_OUTPUT_TOKENS,
      response_format: { type: "json_object" },
      thinking: { type: "disabled" },
    });

    try {
      await this.limiter.acquire(estimatedTokens);

      console.log(
        `[Memory GLM] extract model=${model} ` +
          `batch=[${[...provenance.keys()].join(",")}] ` +
          `ctx=${redactedContext.turns.length} known=${knownMemories.length} chars=${system.length + user.length}` +
          (redactions.length > 0 ? ` redactions=${redactions.join("|")}` : ""),
      );

      const controller = new AbortController();

      /*
       * The timeout spans the ENTIRE exchange: connect, response
       * headers, AND reading the body.
       */
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

      try {
        const response = await this.fetchFn(
          `${this.config.baseUrl}/chat/completions`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${this.config.apiKey}`,
            },
            body,
            signal: controller.signal,
          },
        );

        const text = await response.text();

        if (response.status === 401 || response.status === 403) {
          return failure(
            "auth",
            false,
            null,
            "Provider rejected the API key (auth error). Not retrying.",
          );
        }

        if (response.status === 429) {
          const retryAfterMs =
            parseRetryAfterMs(response.headers.get("retry-after")) ??
            RATE_LIMIT_FALLBACK_MS;

          // ACCOUNT-WIDE limit: a global cooldown so EVERY model and
          // job waits — fallback would hit the same exhausted quota.
          this.limiter.penalty(retryAfterMs);

          return failure(
            "rate_limited",
            true,
            retryAfterMs,
            `Provider rate limit hit (waiting ${Math.round(retryAfterMs / 1000)}s).`,
          );
        }

        if (response.status >= 500) {
          return failure(
            "server",
            true,
            null,
            `Provider server error ${response.status}.`,
          );
        }

        if (response.status < 200 || response.status >= 300) {
          return failure(
            "client",
            false,
            null,
            `Provider client error ${response.status}.`,
          );
        }

        let payload: unknown;

        try {
          payload = JSON.parse(text);
        } catch {
          return failure(
            "malformed",
            true,
            null,
            "Provider returned a non-JSON body.",
          );
        }

        const content = readChoiceContent(payload);

        if (typeof content !== "string") {
          return failure(
            "malformed",
            true,
            null,
            "Provider response had no message content.",
          );
        }

        const parsedPayload = parseExtractionPayload(content, provenance);

        if (!parsedPayload.ok) {
          return failure(
            "malformed",
            true,
            null,
            `Model output rejected: ${parsedPayload.reason}`,
          );
        }

        const usage = readUsage(payload);

        console.log(
          `[Memory GLM] extract ok model=${model} drafts=${parsedPayload.drafts.length}` +
            (usage
              ? ` tokens in=${usage.inputTokens} out=${usage.outputTokens}`
              : ""),
        );

        return {
          ok: true,
          empty: parsedPayload.drafts.length === 0,
          drafts: parsedPayload.drafts,
          usage,
          redactions,
          model,
        };
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return failure(
          "timeout",
          true,
          null,
          `Provider timed out after ${this.config.timeoutMs}ms.`,
        );
      }

      return failure(
        "network",
        true,
        null,
        `Provider request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
