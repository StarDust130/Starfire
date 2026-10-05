import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pacer } from "./quota.js";

export const PROVIDER_NAME = "EmpirioLabs";
export const ENV_KEY = "EMPIRIOLABS_API_KEY";
export const ENV_URL = "EMPIRIOLABS_REALTIME_URL";
export const DEFAULT_MODEL = "qwen3-8-omni-flash-realtime";

export class ProviderError extends Error {
  status?: number; // HTTP-like status when known (401/402/429/503)
  retryAfterMs?: number; // from Retry-After when the provider sends it
}

/** wss://api.empiriolabs.ai/v1/realtime?... → https://api.empiriolabs.ai */
export function httpsBaseFromEndpoint(endpoint: string): string {
  try {
    const u = new URL(endpoint);
    return `https://${u.host}`;
  } catch {
    return "https://api.empiriolabs.ai";
  }
}

export type DriverConfig = {
  provider: string;
  model: string;
  endpoint: string;
  apiKey: string | null;
  timeoutMs: number;
  systemPrompt: string;
  pricePerMTokIn: number | null;
  pricePerMTokOut: number | null;
  pacer?: Pacer;
  minTurnGapMs: number;
};

function deriveModelFromSource(repoRoot: string): {
  model: string | null;
  url: string | null;
} {
  const candidates = [
    join(repoRoot, "apps", "desktop", "electron", "realtimeVoice.ts"),
    join(repoRoot, "apps", "desktop", "electron", "realtimeProtocol.ts"),
  ];
  for (const f of candidates) {
    if (!existsSync(f)) continue;
    try {
      const src = readFileSync(f, "utf8");
      const urlMatch = src.match(/wss:\/\/[^\s"'`)]+/);
      const modelMatch =
        src.match(/["'`](qwen[a-z0-9-]*realtime[a-z0-9-]*)["'`]/i) ??
        src.match(/["'`]([a-z0-9-]+-realtime[a-z0-9-]*)["'`]/i);
      if (modelMatch || urlMatch)
        return {
          model: modelMatch ? modelMatch[1] : null,
          url: urlMatch ? urlMatch[0] : null,
        };
    } catch {
      /* fall through */
    }
  }
  return { model: null, url: null };
}

export function loadProviderConfig(
  repoRoot: string,
  systemPrompt: string,
): DriverConfig {
  const apiKey = process.env[ENV_KEY] ?? null;
  const derived = deriveModelFromSource(repoRoot);
  const model =
    process.env.STARFIRE_EVAL_MODEL ?? derived.model ?? DEFAULT_MODEL;
  const endpoint =
    process.env[ENV_URL] ??
    (derived.url?.includes(model)
      ? derived.url
      : `wss://api.empiriolabs.ai/v1/realtime?model=${model}`);
  const num = (name: string): number | null =>
    process.env[name] ? Number(process.env[name]) : null;
  return {
    provider: PROVIDER_NAME,
    model,
    endpoint,
    apiKey,
    timeoutMs: num("STARFIRE_EVAL_TIMEOUT_MS") ?? 60_000,
    systemPrompt,
    pricePerMTokIn:
      num("EMPIRIOLABS_PRICE_IN") ?? num("STARFIRE_EVAL_PRICE_IN"),
    pricePerMTokOut:
      num("EMPIRIOLABS_PRICE_OUT") ?? num("STARFIRE_EVAL_PRICE_OUT"),
    minTurnGapMs: num("STARFIRE_EVAL_MIN_TURN_GAP_MS") ?? 1500,
  };
}
