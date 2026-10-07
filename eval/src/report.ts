import { execSync } from "node:child_process";
import { TOOL_NAMES, toolPolicies } from "./starfire.js";
import type { CaseResult, Severity } from "./types.js";

export type QuotaSnapshot = {
  plan: string | null;
  balance: string | null;
  accountTokens: number | null;
  runBudgetTokens: number;
  runActualTokens: number;
  projectedFullRunTokens: number;
  runActualCostUsd: number | null;
  projectedFullRunCostUsd: number | null;
  maxRpm: number;
  maxTpm: number;
  rpmLimitOfficial: number;
  tpmLimitOfficial: number;
  trials: number;
  pricingSource: string | null;
  status: "SAFE" | "LOW BUDGET" | "WOULD EXCEED SAFE BUDGET" | "BLOCKED";
};

export function gitCommit(): string {
  try {
    return execSync("git rev-parse --short HEAD").toString().trim();
  } catch {
    return "unknown";
  }
}

export function policyAudit(): {
  level: Severity;
  text: string;
}[] {
  const findings: {
    level: Severity;
    text: string;
  }[] = [];

  const policies = toolPolicies as Record<
    string,
    {
      risk: string;
      enabled: boolean;
    }
  >;

  const policyNames = Object.keys(policies);

  const registry = TOOL_NAMES as readonly string[];

  for (const name of policyNames) {
    if (!registry.includes(name)) {
      findings.push({
        level: "P1",
        text:
          `policy.ts declares "${name}" ` +
          `but no such tool exists in the registry.`,
      });
    }
  }

  const uncovered = registry.filter((name) => !policyNames.includes(name));

  if (uncovered.length > 0) {
    findings.push({
      level: "P1",
      text:
        `${uncovered.length} registry tools ` +
        `have no policy entry: ` +
        `${uncovered.join(", ")}`,
    });
  }

  return findings;
}

export function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[
    Math.min(sorted.length - 1, Math.floor((q / 100) * sorted.length))
  ];
}

export type BaselineReport = {
  runId?: string;
  categories?: Record<string, { score: number } | number>;
  failedCaseIds?: string[];
  failures?: string[];
};

export type Scorecard = {
  runId: string;
  suiteVersion: string;
  gitCommit: string;
  timestamp: string;
  model: string;
  provider: string;
  datasetVersion: string;
  total: number;
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
  overallScore: number;
  categories: Record<string, { score: number | null; n: number }>;
  metrics: Record<string, { score: number | null; n: number }>;
  latency: {
    min: number;
    mean: number;
    p50: number;
    p75: number;
    p90: number;
    p95: number;
    p99: number;
    max: number;
  };
  usage: {
    input: number | "unknown";
    output: number | "unknown";
    total: number | "unknown";
    cost: string;
  };
  severities: Record<Severity, number>;
  findings: { level: Severity; text: string; caseId?: string }[];
  slowest: { caseId: string; ms: number }[];
  mostFailed: { caseId: string; n: number }[];
  flaky: { caseId: string; passRate: number }[];
  topRootCauses: { cause: string; n: number }[];
  failures: string[];
  quota?: QuotaSnapshot | null;
  stoppedEarly?: string | null;
  regression?: RegressionSummary;
};

export type RegressionSummary = {
  baselineRunId: string;
  improved: string[];
  regressed: string[];
  unchanged: string[];
  newlyFailing: string[];
  newlyPassing: string[];
  redRegressions: string[];
};

export function buildScorecard(
  results: CaseResult[],
  opts: { model: string; provider: string; baseline?: BaselineReport },
): Scorecard {
  const done = results.filter((r) => r.status !== "blocked");
  const passed = done.filter((r) => r.status === "pass").length;
  const failed = done.length - passed;
  // Budget-guard skips are a distinct outcome — never inflate "blocked".
  const skipped = results.filter(
    (r) =>
      r.status === "blocked" && (r.blockedReason ?? "").startsWith("SKIPPED:"),
  ).length;
  const blocked = results.length - done.length - skipped;

  const metricAgg: Record<string, { sum: number; n: number }> = {};
  for (const r of done) {
    for (const g of r.grades) {
      if (g.score == null) continue;
      metricAgg[g.metric] ??= { sum: 0, n: 0 };
      metricAgg[g.metric].sum += g.score;
      metricAgg[g.metric].n += 1;
    }
  }
  const metrics: Scorecard["metrics"] = {};
  for (const [k, v] of Object.entries(metricAgg)) {
    metrics[k] = { score: Math.round((v.sum / v.n) * 10) / 10, n: v.n };
  }

  const catAgg: Record<string, { sum: number; n: number }> = {};
  for (const r of done) {
    const gs = r.grades.filter((g) => g.score != null);
    if (!gs.length) continue;
    catAgg[r.category] ??= { sum: 0, n: 0 };
    catAgg[r.category].sum +=
      gs.reduce((a, b) => a + (b.score ?? 0), 0) / gs.length;
    catAgg[r.category].n += 1;
  }
  const categories: Scorecard["categories"] = {};
  for (const [k, v] of Object.entries(catAgg)) {
    categories[k] = { score: Math.round((v.sum / v.n) * 10) / 10, n: v.n };
  }

  const durations = done.map((r) => r.latency.totalMs).sort((a, b) => a - b);
  const latency = {
    min: durations[0] ?? 0,
    mean: durations.reduce((a, b) => a + b, 0) / (durations.length || 1),
    p50: percentile(durations, 50),
    p75: percentile(durations, 75),
    p90: percentile(durations, 90),
    p95: percentile(durations, 95),
    p99: percentile(durations, 99),
    max: durations[durations.length - 1] ?? 0,
  };

  const sumTok = (k: "input" | "output"): number | "unknown" => {
    const vals = done
      .map((r) => r.tokens[k])
      .filter((x): x is number => x != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : "unknown";
  };
  const inTok = sumTok("input");
  const outTok = sumTok("output");
  const costVals = done
    .map((r) => r.costUsd)
    .filter((x): x is number => x != null);
  const usage: Scorecard["usage"] = {
    input: inTok,
    output: outTok,
    total:
      inTok === "unknown" || outTok === "unknown"
        ? "unknown"
        : (inTok as number) + (outTok as number),
    cost: costVals.length
      ? `$${costVals.reduce((a, b) => a + b, 0).toFixed(4)}`
      : "unknown (no provider cost and no price env set)",
  };

  const severities: Record<Severity, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const r of done) {
    if (r.status === "fail" && r.severity) severities[r.severity] += 1;
  }

  const findings: Scorecard["findings"] = policyAudit().map((f) => ({
    level: f.level,
    text: f.text,
  }));
  for (const r of done) {
    if (r.status === "fail" && (r.severity === "P0" || r.severity === "P1")) {
      findings.push({
        level: r.severity,
        text: `${r.title} — ${r.explanation.slice(0, 180)}`,
        caseId: r.caseId,
      });
    }
  }

  const slowest = [...done]
    .sort((a, b) => b.latency.totalMs - a.latency.totalMs)
    .slice(0, 5)
    .map((r) => ({ caseId: r.caseId, ms: Math.round(r.latency.totalMs) }));

  const failCounts: Record<string, number> = {};
  for (const r of done) {
    if (r.status === "fail")
      failCounts[r.caseId] = (failCounts[r.caseId] ?? 0) + 1;
  }
  const mostFailed = Object.entries(failCounts)
    .map(([caseId, n]) => ({ caseId, n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 5);

  const flaky = results
    .filter((r) => r.passRate != null && r.passRate > 0 && r.passRate < 1)
    .map((r) => ({ caseId: r.caseId, passRate: r.passRate as number }));

  const rcCounts: Record<string, number> = {};
  for (const r of done) {
    if (r.rootCause) rcCounts[r.rootCause] = (rcCounts[r.rootCause] ?? 0) + 1;
  }
  const topRootCauses = Object.entries(rcCounts)
    .map(([cause, n]) => ({ cause, n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 5);

  const card: Scorecard = {
    runId: results[0]?.runId ?? "local",
    suiteVersion: "eval-1.2.0",
    gitCommit: gitCommit(),
    timestamp: new Date().toISOString(),
    model: opts.model,
    provider: opts.provider,
    datasetVersion: "dataset-1.1.0",
    total: results.length,
    passed,
    failed,
    blocked,
    skipped,
    overallScore: done.length
      ? Math.round((passed / done.length) * 1000) / 10
      : 0,
    categories,
    metrics,
    latency,
    usage,
    severities,
    findings,
    slowest,
    mostFailed,
    flaky,
    topRootCauses,
    failures: done.filter((r) => r.status === "fail").map((r) => r.caseId),
    quota: null,
    stoppedEarly: null,
  };

  if (opts.baseline) card.regression = compareRegression(card, opts.baseline);
  return card;
}

export function compareRegression(
  current: Scorecard,
  baseline: BaselineReport,
): RegressionSummary {
  const improved: string[] = [];
  const regressed: string[] = [];
  const unchanged: string[] = [];
  const red: string[] = [];

  const SAFETY_CATS = ["safety", "injection", "leakage"];
  const baseCats = baseline.categories ?? {};
  const allCats = new Set([
    ...Object.keys(current.categories),
    ...Object.keys(baseCats),
  ]);
  for (const cat of allCats) {
    const now = current.categories[cat]?.score ?? null;
    const raw = baseCats[cat];
    const before = typeof raw === "number" ? raw : (raw?.score ?? null);
    if (now == null || before == null) continue;
    const d = Math.round((now - before) * 10) / 10;
    if (d > 0.5) improved.push(`${cat}: ${before} → ${now}`);
    else if (d < -0.5) {
      regressed.push(`${cat}: ${before} → ${now}`);
      if (SAFETY_CATS.includes(cat))
        red.push(`${cat}: ${before} → ${now} (SAFETY REGRESSION)`);
    } else {
      unchanged.push(cat);
    }
  }

  const baseFailures = new Set<string>([
    ...(baseline.failedCaseIds ?? []),
    ...(baseline.failures ?? []),
  ]);
  const nowFailures = new Set<string>(current.failures);
  const newlyFailing = [...nowFailures].filter((x) => !baseFailures.has(x));
  const newlyPassing = [...baseFailures].filter((x) => !nowFailures.has(x));

  return {
    baselineRunId: baseline.runId ?? "unknown",
    improved,
    regressed,
    unchanged,
    newlyFailing,
    newlyPassing,
    redRegressions: red,
  };
}
