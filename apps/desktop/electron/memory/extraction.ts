import { z } from "zod";

import {
  MAX_MEMORY_CHARS,
  MAX_SOURCE_IDS,
  MEMORY_CATEGORIES,
  type MemoryCategory,
  normalizeKey,
} from "./memories.js";

import { ExtractionRateLimiter, estimateTokens } from "./rate-limit.js";

import { redactTurns } from "./redaction.js";

/*
 * GLM extraction provider — the ONLY place Starfire talks to a cloud
 * model about memories. Pure: turns in -> drafts out. No database
 * access, no queue access; the orchestrator (next slice) owns those.
 *
 * Provider details (from the official model docs, not guessed):
 * POST {baseUrl}/chat/completions, bearer key, model glm-4-7-flash,
 * JSON mode via response_format, thinking disabled for latency,
 * no tools and no web search for extraction.
 */

export const DEFAULT_MEMORY_BASE_URL = "https://api.empiriolabs.ai/v1";

export const DEFAULT_MEMORY_MODEL = "glm-4-7-flash";

export const DEFAULT_MAX_REQUESTS_PER_MINUTE = 40;

export const DEFAULT_MAX_TOKENS_PER_MINUTE = 1_600_000;

export const DEFAULT_MIN_INTERVAL_MS = 1_200;

export const DEFAULT_EXTRACTION_TIMEOUT_MS = 30_000;

export const EXTRACTION_MAX_OUTPUT_TOKENS = 2_000;

export const EXTRACTION_MAX_DRAFTS = 12;

export const EXTRACTION_CONTEXT_TURNS = 12;

export const CONTEXT_TURN_MAX_CHARS = 400;

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

  return {
    enabled: !disabled && apiKey !== null,
    apiKey,
    baseUrl: env.STARFIRE_MEMORY_BASE_URL?.trim() || DEFAULT_MEMORY_BASE_URL,
    model: env.STARFIRE_MEMORY_MODEL?.trim() || DEFAULT_MEMORY_MODEL,
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
1. Extract ONLY from NEW MESSAGES. The CONTEXT block exists to resolve pronouns and fragments ("My name is." / "Or more."). Never extract from CONTEXT, never invent facts.
2. Ignore small talk, greetings, news, weather, tool results, and anything transient.
3. NEVER store secrets or anything marked [REDACTED:...]. Treat redacted values as unknown.
4. key: short stable english identifier, lowercase, letters/digits/dots/dashes only (e.g. "user.name", "editor", "goal.career", "project.starfire"). Reuse the same key when a later message updates the same fact.
5. content: ONE concise sentence, third person, grounded ONLY in what was said. Keep the user's language for names and terms. Max ~200 chars.
6. importance: 5 = core identity or major goal, 4 = strong preference or project, 3 = normal fact, 2 = minor, 1 = trivia.
7. sourceMessageIds: the #ids from NEW MESSAGES this fact came from.
8. If two messages conflict, use the newest statement.
9. If nothing is worth remembering return {"memories":[]} — empty is CORRECT for most small talk.
10. At most 12 memories. Quality over quantity.`;

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
}): { system: string; user: string } {
  const contextBlock = input.context
    .slice(-EXTRACTION_CONTEXT_TURNS)
    .map(
      (turn) =>
        `#${turn.id} ${turn.role}: ${clampChars(turn.content, CONTEXT_TURN_MAX_CHARS)}`,
    )
    .join("\n");

  const batchBlock = input.batch
    .map((turn) => `#${turn.id} ${turn.role}: ${turn.content}`)
    .join("\n");

  const user = `${CONTEXT_HEADER}\n${contextBlock || "(none)"}\n\n${BATCH_HEADER}\n${batchBlock}\n\n${FOOTER}`;

  return { system: SYSTEM_PROMPT, user };
}

const draftSchema = z.object({
  category: z.enum(MEMORY_CATEGORIES),
  key: z.string().min(1).max(200),
  content: z.string().min(1),
  importance: z.coerce.number().optional(),
  sourceMessageIds: z.array(z.coerce.number().int().positive()).default([]),
});

const payloadSchema = z.object({
  memories: z.array(z.unknown()).max(50),
});

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
 * Strict-but-fair validation: the whole payload must be a JSON object
 * with a memories array; individual bad items are dropped instead of
 * poisoning the batch. Provenance ids outside the batch are dropped.
 */
export function parseExtractionPayload(
  raw: string,
  allowedIds: ReadonlySet<number>,
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

  const payload = payloadSchema.safeParse(parsed);

  if (!payload.success) {
    return { ok: false, reason: 'expected {"memories":[...]}' };
  }

  const drafts: ExtractedMemoryDraft[] = [];

  for (const item of payload.data.memories) {
    const checked = draftSchema.safeParse(item);

    if (!checked.success) {
      continue;
    }

    const key = normalizeKey(checked.data.key);

    const content = checked.data.content.trim().slice(0, MAX_MEMORY_CHARS);

    if (key.length === 0 || content.length === 0) {
      continue;
    }

    const sourceIds = [
      ...new Set(
        checked.data.sourceMessageIds.filter((id) => allowedIds.has(id)),
      ),
    ].slice(0, MAX_SOURCE_IDS);

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

function snippet(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();

  return clean.length > 200 ? `${clean.slice(0, 200)}…` : clean;
}

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) {
    return null;
  }

  const seconds = Number(header.trim());

  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }

  return Math.max(1_000, Math.round(seconds * 1_000));
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
  }): Promise<ExtractionResult> {
    const next = (): Promise<ExtractionResult> => this.runOnce(input);

    const run = this.chain.then(next, next) as Promise<ExtractionResult>;

    this.chain = run;

    return run;
  }

  private async runOnce(input: {
    context: readonly ExtractionTurn[];
    batch: readonly ExtractionTurn[];
  }): Promise<ExtractionResult> {
    if (!this.isConfigured()) {
      return failure(
        "disabled",
        false,
        null,
        "Extraction is not configured (missing API key or disabled).",
      );
    }

    const allowedIds = new Set(input.batch.map((turn) => turn.id));

    const redactedBatch = redactTurns(input.batch);

    const redactedContext = redactTurns(input.context);

    const redactions = [
      ...new Set([...redactedBatch.redactions, ...redactedContext.redactions]),
    ];

    const { system, user } = buildExtractionMessages({
      context: redactedContext.turns,
      batch: redactedBatch.turns,
    });

    const estimatedTokens = estimateTokens(system.length + user.length);

    const body = JSON.stringify({
      model: this.config.model,
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
        `[Memory GLM] extract batch=[${[...allowedIds].join(",")}] ` +
          `ctx=${redactedContext.turns.length} chars=${system.length + user.length}` +
          (redactions.length > 0 ? ` redactions=${redactions.join("|")}` : ""),
      );

      const controller = new AbortController();

      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

      let response: Response;

      try {
        response = await this.fetchFn(
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
      } finally {
        clearTimeout(timer);
      }

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
        const retryAfterMs = parseRetryAfterMs(
          response.headers.get("retry-after"),
        );

        return failure(
          "rate_limited",
          true,
          retryAfterMs,
          `Provider rate limit hit (retry-after=${retryAfterMs ?? "unknown"}).`,
        );
      }

      if (response.status >= 500) {
        return failure(
          "server",
          true,
          null,
          `Provider server error ${response.status}: ${snippet(text)}`,
        );
      }

      if (response.status < 200 || response.status >= 300) {
        return failure(
          "client",
          false,
          null,
          `Provider client error ${response.status}: ${snippet(text)}`,
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

      const parsedPayload = parseExtractionPayload(content, allowedIds);

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
        `[Memory GLM] extract ok drafts=${parsedPayload.drafts.length}` +
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
      };
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
