import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** EmpirioLabs official account defaults — the hard ceiling, never exceeded. */
export const OFFICIAL_RPM = 50;
export const OFFICIAL_TPM = 2_000_000;
/** Conservative fallback when no run history exists (your measured avg is ~4,832). */
export const ESTIMATE_TOKENS_PER_CASE = 6000;

export type QuotaConfig = {
  maxCases: number | null; // null = full run allowed
  trials: number;
  maxTokens: number;
  maxCostUsd: number | null;
  maxRpm: number;
  maxTpm: number;
  minTurnGapMs: number;
  marginPct: number;
  explicitBudget: boolean; // true if STARFIRE_EVAL_MAX_TOKENS was set by the user
};

export function loadQuotaConfig(): QuotaConfig {
  const env = process.env;
  const num = (k: string): number | null =>
    env[k] != null && env[k] !== "" ? Number(env[k]) : null;
  const full =
    env.STARFIRE_EVAL_ALLOW_FULL_RUN === "true" ||
    env.STARFIRE_EVAL_ALLOW_FULL_RUN === "1";
  const explicitMaxTokens = num("STARFIRE_EVAL_MAX_TOKENS");
  return {
    maxCases: full ? null : (num("STARFIRE_EVAL_MAX_CASES") ?? 25),
    trials: Math.max(1, num("STARFIRE_EVAL_TRIALS") ?? 1),
    maxTokens: explicitMaxTokens ?? 1_000_000,
    maxCostUsd: num("STARFIRE_EVAL_MAX_COST_USD"),
    maxRpm: Math.min(num("STARFIRE_EVAL_MAX_RPM") ?? 40, OFFICIAL_RPM),
    maxTpm: Math.min(num("STARFIRE_EVAL_MAX_TPM") ?? 1_800_000, OFFICIAL_TPM),
    minTurnGapMs: num("STARFIRE_EVAL_MIN_TURN_GAP_MS") ?? 1500,
    marginPct: 25,
    explicitBudget: explicitMaxTokens != null,
  };
}

/* ---------------- Account usage API ---------------- */

export type UsageInfo = {
  available: boolean;
  reason?: string;
  httpStatus?: number;
  plan?: string;
  planStatus?: string;
  balance?: string;
  totalTokens?: number;
  totalCost?: string;
  avgLatencyMs?: number;
  errors?: number;
  recentRequests?: number;
};

export class HttpError extends Error {
  status: number;
  retryAfterMs?: number;
  constructor(status: number, message: string, retryAfterMs?: number) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** fetch with 429-aware bounded retry: Retry-After header, else exponential backoff + jitter. */
export async function fetchWithRetry(
  url: string,
  apiKey: string,
  maxAttempts = 4,
): Promise<Response> {
  let lastErr: HttpError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
    } catch (e) {
      throw new HttpError(0, `network error: ${String(e)}`);
    }
    if (res.ok) return res;
    const retryAfter = res.headers.get("retry-after");
    const retryMs = retryAfter != null ? Number(retryAfter) * 1000 : undefined;
    const err = new HttpError(
      res.status,
      `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
      retryMs,
    );
    if (res.status === 429 && attempt < maxAttempts) {
      const wait =
        retryMs ?? 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 500);
      process.stderr.write(
        `⏳ rate limited — retry after ${Math.ceil(wait / 1000)}s (attempt ${attempt}/${maxAttempts})\n`,
      );
      await sleep(wait);
      lastErr = err;
      continue;
    }
    throw err;
  }
  throw lastErr ?? new HttpError(429, "rate limited");
}

/** Shallow-recursive key search — usage API shape is not contractually fixed. */
function findKey(obj: unknown, re: RegExp, depth = 3): unknown {
  if (obj == null || typeof obj !== "object" || depth < 0) return undefined;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (
      re.test(k) &&
      (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    )
      return v;
  }
  for (const v of Object.values(obj as Record<string, unknown>)) {
    if (v != null && typeof v === "object") {
      const hit = findKey(v, re, depth - 1);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

export async function fetchAccountUsage(
  httpsBase: string,
  apiKey: string,
): Promise<UsageInfo> {
  try {
    const res = await fetchWithRetry(`${httpsBase}/v1/account/usage`, apiKey);
    const raw = (await res.json()) as unknown;
    return {
      available: true,
      plan: findKey(raw, /plan(?!.*status)/i) as string | undefined,
      planStatus: findKey(raw, /plan.?status|status/i) as string | undefined,
      balance: findKey(raw, /balance|credit/i) as string | undefined,
      totalTokens: findKey(raw, /total.?tokens?|tokens?.used/i) as
        | number
        | undefined,
      totalCost: findKey(raw, /total.?cost|cost/i) as string | undefined,
      avgLatencyMs: findKey(raw, /avg.?latency|latency/i) as number | undefined,
      errors: findKey(raw, /errors?/i) as number | undefined,
      recentRequests: findKey(raw, /recent.?requests?|requests?/i) as
        | number
        | undefined,
    };
  } catch (e) {
    const http = e instanceof HttpError ? e : null;
    return {
      available: false,
      reason: http?.message ?? String(e),
      httpStatus: http?.status,
    };
  }
}

export type Pricing = { inputPerMTok: number; outputPerMTok: number } | null;

export async function fetchModelPricing(
  httpsBase: string,
  apiKey: string,
  model: string,
): Promise<{ pricing: Pricing; source: string | null }> {
  try {
    const res = await fetchWithRetry(
      `${httpsBase}/v1/models/${encodeURIComponent(model)}`,
      apiKey,
    );
    const raw = (await res.json()) as unknown;
    // Look for an object with input+output numeric prices under a price/cost/rate path.
    const walk = (o: unknown, path: string, depth: number): Pricing => {
      if (o == null || typeof o !== "object" || depth < 0) return null;
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
        if (v != null && typeof v === "object") {
          const hit = walk(v, `${path}.${k}`, depth - 1);
          if (hit) return hit;
        }
      }
      if (/price|cost|rate/i.test(path)) {
        const keys = Object.keys(o as Record<string, unknown>);
        const inK = keys.find(
          (k) =>
            /input|prompt/i.test(k) &&
            typeof (o as Record<string, unknown>)[k] === "number",
        );
        const outK = keys.find(
          (k) =>
            /output|completion/i.test(k) &&
            typeof (o as Record<string, unknown>)[k] === "number",
        );
        if (inK && outK) {
          const inp = (o as Record<string, unknown>)[inK] as number;
          const outp = (o as Record<string, unknown>)[outK] as number;
          if (inp > 0 && inp < 1000 && outp < 1000)
            return { inputPerMTok: inp, outputPerMTok: outp };
        }
      }
      return null;
    };
    return {
      pricing: walk(raw, "root", 4),
      source: "/v1/models pricing metadata",
    };
  } catch {
    return { pricing: null, source: null };
  }
}

/* ---------------- Projection ---------------- */

export type History = {
  avgIn: number;
  avgOut: number;
  avgTotal: number;
  samples: number;
  source: "measured" | "estimate";
};

export function historicalTokens(reportsDir: string): History {
  const vals: { in: number; out: number; total: number }[] = [];
  const push = (r: {
    status?: string;
    tokens?: {
      input?: number | null;
      output?: number | null;
      total?: number | null;
    };
  }): void => {
    if (r.status !== "blocked" && r.tokens?.total != null) {
      vals.push({
        in: r.tokens.input ?? 0,
        out: r.tokens.output ?? 0,
        total: r.tokens.total,
      });
    }
  };
  const latest = join(reportsDir, "latest.json");
  if (existsSync(latest)) {
    try {
      const j = JSON.parse(readFileSync(latest, "utf8")) as {
        cases?: Parameters<typeof push>[0][];
      };
      for (const c of j.cases ?? []) push(c);
    } catch {
      /* corrupt file → ignore */
    }
  }
  const runs = join(reportsDir, "runs");
  if (existsSync(runs)) {
    for (const d of readdirSync(runs)) {
      const f = join(runs, d, "results.jsonl");
      if (!existsSync(f)) continue;
      try {
        for (const line of readFileSync(f, "utf8").split("\n")) {
          if (line.trim()) push(JSON.parse(line) as Parameters<typeof push>[0]);
        }
      } catch {
        /* skip bad line */
      }
    }
  }
  if (!vals.length)
    return {
      avgIn: 5700,
      avgOut: 300,
      avgTotal: ESTIMATE_TOKENS_PER_CASE,
      samples: 0,
      source: "estimate",
    };
  const n = vals.length;
  return {
    avgIn: vals.reduce((a, b) => a + b.in, 0) / n,
    avgOut: vals.reduce((a, b) => a + b.out, 0) / n,
    avgTotal: vals.reduce((a, b) => a + b.total, 0) / n,
    samples: n,
    source: "measured",
  };
}

export function projectedTokens(
  h: History,
  cases: number,
  trials: number,
  marginPct: number,
): number {
  return Math.ceil(h.avgTotal * cases * trials * (1 + marginPct / 100));
}
export function projectedCost(
  h: History,
  cases: number,
  trials: number,
  marginPct: number,
  p: Pricing,
): number | null {
  if (!p) return null;
  const k = cases * trials * (1 + marginPct / 100);
  return (
    (h.avgIn / 1e6) * p.inputPerMTok * k +
    (h.avgOut / 1e6) * p.outputPerMTok * k
  );
}
export function safeCaseCount(
  budgetRemaining: number,
  h: History,
  trials: number,
  marginPct: number,
): number {
  const per = h.avgTotal * trials * (1 + marginPct / 100);
  return Math.max(0, Math.floor(budgetRemaining / per));
}

/* ---------------- Live pacing (sliding window) ---------------- */

export class Pacer {
  private reqTimes: number[] = [];
  private tokenEvents: { t: number; n: number }[] = [];

  constructor(
    private maxRpm: number,
    private maxTpm: number,
    private gapMs: number,
  ) {}

  rpm(): number {
    const now = Date.now();
    this.reqTimes = this.reqTimes.filter((t) => now - t < 60_000);
    return this.reqTimes.length;
  }
  tpm(): number {
    const now = Date.now();
    this.tokenEvents = this.tokenEvents.filter((x) => now - x.t < 60_000);
    return this.tokenEvents.reduce((a, b) => a + b.n, 0);
  }

  /** Blocks until a request slot is safe; records the request. Concurrency is 1 by design. */
  async beforeRequest(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.reqTimes = this.reqTimes.filter((t) => now - t < 60_000);
      this.tokenEvents = this.tokenEvents.filter((x) => now - x.t < 60_000);
      const rpmFull = this.reqTimes.length >= this.maxRpm;
      const tpmFull = this.tpm() >= this.maxTpm;
      if (!rpmFull && !tpmFull) break;
      const waitMs = rpmFull
        ? 60_000 - (now - this.reqTimes[0]) + 250
        : 60_000 - (now - this.tokenEvents[0].t) + 250;
      process.stderr.write(
        `   ⏳ pacing: waiting ${Math.ceil(Math.min(waitMs, 60_000) / 1000)}s (rpm ${this.reqTimes.length}/${this.maxRpm} · tpm ${this.tpm()}/${this.maxTpm})\n`,
      );
      await sleep(Math.min(waitMs, 60_000));
    }
    const last = this.reqTimes[this.reqTimes.length - 1];
    if (last != null) {
      const since = Date.now() - last;
      if (since < this.gapMs) await sleep(this.gapMs - since);
    }
    this.reqTimes.push(Date.now());
  }

  recordTokens(n: number): void {
    if (n > 0) this.tokenEvents.push({ t: Date.now(), n });
  }
}
