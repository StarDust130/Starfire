import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";

import { join } from "node:path";
import { runCaseWithModel } from "./driver.js";
import { gradeCase } from "./grade.js";
import { renderHtml } from "./html.js";
import { runJudge } from "./judge.js";
import { type DriverConfig, httpsBaseFromEndpoint } from "./provider.js";
import {
  fetchAccountUsage,
  fetchModelPricing,
  type History,
  historicalTokens,
  loadQuotaConfig,
  Pacer,
  type Pricing,
  projectedCost,
  projectedTokens,
  type QuotaConfig,
  safeCaseCount,
  type UsageInfo,
} from "./quota.js";

import { renderCaseLine, renderScorecard } from "./render.js";
import {
  type BaselineReport,
  buildScorecard,
  gitCommit,
  type Scorecard,
} from "./report.js";
import type { CaseResult, EvalCase } from "./types.js";

export type RunOptions = {
  verbose: boolean;
  quiet: boolean;
  onlyFailed: boolean;
  trials: number;
  categories?: string[];
  max?: number;
  caseIds?: string[];
  full: boolean;
  resumeRunId?: string;
  baselinePath?: string;
  cfg: DriverConfig;
  pyBin: string;
};

const fmt = (n: number): string => Math.round(n).toLocaleString("en-US");

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function emptyMetrics(): CaseResult["latency"] {
  return {
    modelMs: 0,
    toolMs: 0,
    totalMs: 0,
    llmIterations: 0,
  };
}

function stub(
  c: EvalCase,
  runId: string,
  cfg: DriverConfig,
  status: "blocked",
  reason: string,
): CaseResult {
  return {
    runId,
    caseId: c.id,
    title: c.title,
    category: c.category,
    tags: c.tags,
    status,
    blockedReason: reason,
    model: cfg.model,
    provider: cfg.provider,
    durationMs: 0,
    latency: emptyMetrics(),
    tokens: {
      input: null,
      output: null,
      total: null,
    },
    costUsd: null,
    toolCalls: [],
    finalResponse: "",
    transcript: [],
    stateBefore: null,
    stateAfter: null,
    stateDiff: null,
    invariantViolations: [],
    grades: [],
    failureKinds: [],
    severity: null,
    rootCause: null,
    explanation: reason,
    retries: 0,
  };
}

function skipStub(c: EvalCase, runId: string, cfg: DriverConfig): CaseResult {
  return stub(
    c,
    runId,
    cfg,
    "blocked",
    "SKIPPED: token/cost budget guard — run stopped safely before this case",
  );
}

function loadResume(dir: string): {
  results: CaseResult[];
  completed: Set<string>;
} {
  const f = join(dir, "results.jsonl");
  const results: CaseResult[] = [];
  const completed = new Set<string>();

  if (!existsSync(f)) return { results, completed };

  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;

    try {
      const r = JSON.parse(line) as CaseResult;
      results.push(r);

      if (r.status === "pass" || r.status === "fail") {
        completed.add(r.caseId);
      }
    } catch {
      /* skip bad line */
    }
  }

  return { results, completed };
}

export async function runEval(
  cases: EvalCase[],
  opts: RunOptions,
): Promise<Scorecard> {
  const quota: QuotaConfig = loadQuotaConfig();

  const resumed = Boolean(opts.resumeRunId);

  const runId = opts.resumeRunId ?? `${Date.now()}-${gitCommit()}`;

  process.env.STARFIRE_RUN_ID = runId;

  const dir = join("eval", "reports", "runs", runId);

  mkdirSync(dir, { recursive: true });
  mkdirSync(join("eval", "reports"), { recursive: true });

  const jsonl = join(dir, "results.jsonl");

  /* ---------- case selection ---------- */

  let selected = cases;

  if (opts.caseIds?.length) {
    selected = selected.filter((c) => opts.caseIds?.includes(c.id));
  }

  if (opts.categories?.length) {
    selected = selected.filter((c) => opts.categories?.includes(c.category));
  }

  const cap = opts.full ? null : (opts.max ?? quota.maxCases);

  if (cap != null) selected = selected.slice(0, cap);

  if (opts.onlyFailed) {
    const latestPath = join("eval", "reports", "latest.json");

    if (existsSync(latestPath)) {
      try {
        const prev = JSON.parse(readFileSync(latestPath, "utf8")) as {
          cases?: CaseResult[];
        };

        const failedIds = new Set(
          (prev.cases ?? [])
            .filter((r) => r.status === "fail")
            .map((r) => r.caseId),
        );

        selected = selected.filter((c) => failedIds.has(c.id));
      } catch {
        /* no usable baseline → run as selected */
      }
    }
  }

  let priorResults: CaseResult[] = [];
  let completed = new Set<string>();

  if (resumed) {
    const r = loadResume(dir);

    priorResults = r.results.filter((x) => x.status !== "blocked");
    completed = r.completed;
  }

  const toRun = selected.filter((c) => !completed.has(c.id));

  /* ---------- preflight (only when there is a key and something to run) ---------- */

  let usage: UsageInfo | null = null;
  let pricing: Pricing = null;
  let pricingSource: string | null = null;

  let history: History = {
    avgIn: 5700,
    avgOut: 300,
    avgTotal: 6000,
    samples: 0,
    source: "estimate",
  };

  let actualTokens = 0;
  let actualCost = 0;
  let stoppedEarly: string | null = null;

  console.error(`[eval] provider: ${opts.cfg.provider}`);
  console.error(`[eval] model: ${opts.cfg.model}`);
  console.error(`[eval] endpoint: ${opts.cfg.endpoint}`);

  console.error(
    opts.cfg.apiKey
      ? "[eval] auth: EMPIRIOLABS_API_KEY ✅"
      : "[eval] auth: EMPIRIOLABS_API_KEY ❌ missing",
  );

  console.error(
    `[eval] dataset: ${cases.length} cases | selected: ${selected.length} | to run: ${toRun.length}${resumed ? ` (resume ${runId}: ${completed.size} already done)` : ""}`,
  );

  console.error(
    `[eval] trials: ${quota.trials} | cases cap: ${cap ?? "none (--full)"} | budget: ${fmt(quota.maxTokens)} tokens${quota.maxCostUsd != null ? ` | cost cap: $${quota.maxCostUsd}` : ""}`,
  );

  const results: CaseResult[] = [...priorResults];

  const preflightBlocked: string | null = !opts.cfg.apiKey
    ? "EMPIRIOLABS_API_KEY is not set — refusing to fake results"
    : null;

  if (!preflightBlocked && toRun.length > 0) {
    const httpsBase = httpsBaseFromEndpoint(opts.cfg.endpoint);

    usage = await fetchAccountUsage(httpsBase, opts.cfg.apiKey ?? "");

    if (usage.available) {
      console.error(
        `[quota] plan: ${usage.plan ?? "unknown"}${usage.planStatus ? ` (${usage.planStatus})` : ""}`,
      );

      if (usage.balance != null) {
        console.error(`[quota] balance: ${usage.balance}`);
      }

      if (usage.totalTokens != null) {
        console.error(
          `[quota] actual usage: ${fmt(usage.totalTokens)} tokens (provider-reported)`,
        );
      }

      if (usage.totalCost != null) {
        console.error(`[quota] provider cost: ${usage.totalCost}`);
      }

      if (usage.errors != null) {
        console.error(`[quota] provider errors: ${usage.errors}`);
      }

      if (
        typeof usage.planStatus === "string" &&
        /disabl|suspend|expire|past_due/i.test(usage.planStatus)
      ) {
        console.error(
          `❌ BLOCKED: plan status "${usage.planStatus}" — fix the account before evaluating`,
        );

        for (const c of toRun) {
          results.push(
            stub(
              c,
              runId,
              opts.cfg,
              "blocked",
              `plan status ${usage?.planStatus} — account not usable`,
            ),
          );
        }

        usage = null;
      }
    } else {
      const why = usage.reason ?? "unavailable";

      if (usage.httpStatus === 401) {
        console.error("❌ BLOCKED: EMPIRIOLABS_API_KEY is invalid (401)");

        for (const c of toRun) {
          results.push(
            stub(
              c,
              runId,
              opts.cfg,
              "blocked",
              "AUTH (401): key rejected by /v1/account/usage",
            ),
          );
        }
      } else if (usage.httpStatus === 402) {
        console.error("❌ BLOCKED: insufficient credits (402)");

        for (const c of toRun) {
          results.push(
            stub(
              c,
              runId,
              opts.cfg,
              "blocked",
              "INSUFFICIENT CREDITS (402): account balance exhausted",
            ),
          );
        }
      } else if (quota.explicitBudget) {
        console.error(
          `[quota] usage endpoint unavailable (${why}) — continuing with EXPLICIT budget ${fmt(quota.maxTokens)} tokens`,
        );
      } else {
        console.error(
          `❌ BLOCKED: usage endpoint unavailable (${why}) and no explicit STARFIRE_EVAL_MAX_TOKENS configured`,
        );

        for (const c of toRun) {
          results.push(
            stub(
              c,
              runId,
              opts.cfg,
              "blocked",
              `usage endpoint unavailable and no explicit budget: ${why}`,
            ),
          );
        }
      }
    }

    // pricing (optional)
    if (usage?.available && opts.cfg.pricePerMTokIn == null) {
      const p = await fetchModelPricing(
        httpsBase,
        opts.cfg.apiKey ?? "",
        opts.cfg.model,
      );

      if (p.pricing) {
        pricing = p.pricing;
        pricingSource = p.source;
        opts.cfg.pricePerMTokIn = p.pricing.inputPerMTok;
        opts.cfg.pricePerMTokOut = p.pricing.outputPerMTok;
      }
    }

    history = historicalTokens(join("eval", "reports"));

    const proj = projectedTokens(
      history,
      toRun.length,
      quota.trials,
      quota.marginPct,
    );

    const projCost = projectedCost(
      history,
      toRun.length,
      quota.trials,
      quota.marginPct,
      pricing,
    );

    const remaining = quota.maxTokens; // run-local budget (account totals are display-only)

    console.error(
      `[quota] run budget: ${fmt(quota.maxTokens)} tokens | rpm limit: (official 50) safe target: ${quota.maxRpm} | tpm safe target: ${fmt(quota.maxTpm)}`,
    );

    console.error(
      `[quota] tokens/case: ${fmt(history.avgTotal)} (${history.source}${history.samples ? `, ${history.samples} samples` : ""}) × ${toRun.length} cases × ${quota.trials} trials + ${quota.marginPct}% margin`,
    );

    console.error(
      `[quota] PROJECTED run: ${fmt(proj)} tokens${projCost != null ? ` | PROJECTED cost: $${projCost.toFixed(2)}` : " | cost: UNKNOWN"}`,
    );

    if (
      proj > remaining &&
      results.filter((r) => r.blockedReason?.startsWith("SKIPPED")).length ===
        0 &&
      results.every(
        (r) =>
          !r.blockedReason?.includes("401") &&
          !r.blockedReason?.includes("402") &&
          !r.blockedReason?.includes("plan status"),
      )
    ) {
      const safe = safeCaseCount(
        remaining,
        history,
        quota.trials,
        quota.marginPct,
      );

      console.error(
        "⛔ EVAL BLOCKED — projected token usage exceeds safe budget",
      );

      console.error(
        `   current usage:  ${fmt(usage?.totalTokens ?? 0)} (account) / run budget ${fmt(quota.maxTokens)}`,
      );

      console.error(`   projected:      ${fmt(proj)}`);

      console.error(`   safe budget:    ${fmt(remaining)}`);

      console.error(`   cases safe to run: ${safe}`);

      console.error(`   recommended:    pnpm eval --max ${Math.max(1, safe)}`);

      for (const c of toRun) {
        results.push(
          stub(
            c,
            runId,
            opts.cfg,
            "blocked",
            `SKIPPED: preflight — projected ${fmt(proj)} tokens exceeds safe budget ${fmt(remaining)}; run pnpm eval --max ${Math.max(1, safe)}`,
          ),
        );
      }
    } else if (toRun.length > 0 && results.length === priorResults.length) {
      // Safe to run — attach pacer and proceed.
      opts.cfg.pacer = new Pacer(
        quota.maxRpm,
        quota.maxTpm,
        quota.minTurnGapMs,
      );

      console.error("🟢 SAFE TO RUN\n");
    }
  } else if (preflightBlocked && toRun.length > 0) {
    console.error(`❌ BLOCKED: ${preflightBlocked}`);

    for (const c of toRun) {
      results.push(stub(c, runId, opts.cfg, "blocked", preflightBlocked));
    }
  }

  /* ---------- execution loop: concurrency=1, budget-checked before EVERY case ---------- */

  let executedInThisRun = 0;

  const runList = toRun.filter((c) => !results.some((r) => r.caseId === c.id));

  for (let i = 0; i < runList.length; i++) {
    const c = runList[i];
    const trialsLeft = quota.trials;
    const perCase = history.avgTotal * trialsLeft * (1 + quota.marginPct / 100);

    // STOP EARLY — before the request, never after the provider complains.
    if (actualTokens + perCase > quota.maxTokens) {
      const proj2 = projectedTokens(
        history,
        runList.length - i,
        quota.trials,
        quota.marginPct,
      );

      stoppedEarly = `token budget guard: actual ${fmt(actualTokens)} + projected remaining ${fmt(proj2)} would exceed ${fmt(quota.maxTokens)}`;

      console.error(
        `\n[quota] ACTUAL tokens so far: ${fmt(actualTokens)} / ${fmt(quota.maxTokens)}`,
      );

      console.error(
        `[quota] PROJECTED total: ${fmt(actualTokens + proj2)} — exceeds budget`,
      );

      console.error("⚠ STOPPING BEFORE MORE REQUESTS — saving results");

      console.error(`   resume later with: pnpm eval --resume ${runId}\n`);

      for (const rest of runList.slice(i)) {
        results.push(skipStub(rest, runId, opts.cfg));
      }

      break;
    }

    if (
      quota.maxCostUsd != null &&
      pricing &&
      actualCost +
        (projectedCost(history, 1, trialsLeft, quota.marginPct, pricing) ?? 0) >
        quota.maxCostUsd
    ) {
      stoppedEarly = `cost budget guard: actual $${actualCost.toFixed(2)} approaching cap $${quota.maxCostUsd}`;

      console.error(
        "\n⚠ STOPPING BEFORE MORE REQUESTS (cost guard) — saving results",
      );

      for (const rest of runList.slice(i)) {
        results.push(skipStub(rest, runId, opts.cfg));
      }

      break;
    }

    const trialResults: CaseResult[] = [];

    for (let t = 0; t < trialsLeft; t++) {
      const raw = await runCaseWithModel(opts.cfg, c);
      trialResults.push(gradeCase(c, raw));
    }

    const r = trialResults[0];

    if (trialsLeft > 1) {
      r.trials = trialResults.map((x) => ({
        pass: x.status === "pass",
        score: x.grades.length
          ? x.grades.filter((g) => g.passed).length / x.grades.length
          : 0,
      }));

      r.passRate = r.trials.filter((t) => t.pass).length / trialsLeft;

      if (
        trialResults.some((x) => x.status === "fail") &&
        r.status === "pass"
      ) {
        r.status = "fail";
        r.severity = r.severity ?? "P2";
        r.rootCause = r.rootCause ?? "AGENT_LOOP";

        r.explanation = `flaky: pass rate ${Math.round(
          r.passRate * 100,
        )}% across ${trialsLeft} trials — ${r.explanation}`;
      }
    }

    r.retries = trialResults.reduce((a, b) => a + (b.retries ?? 0), 0);

    results.push(r);

    actualTokens += r.tokens.total ?? 0;
    actualCost += r.costUsd ?? 0;
    executedInThisRun += 1;

    try {
      appendFileSync(jsonl, `${JSON.stringify(r)}\n`);
    } catch {
      /* keep going */
    }

    if (opts.quiet) {
      try {
        console.log(
          JSON.stringify({
            caseId: r.caseId,
            status: r.status,
            severity: r.severity,
            rootCause: r.rootCause,
            ms: Math.round(r.durationMs),
            tokens: r.tokens.total,
          }),
        );
      } catch {}
    } else if (!opts.onlyFailed || r.status === "fail") {
      try {
        renderCaseLine(i, runList.length, r, opts.verbose);
      } catch {}
    }

    // live quota display every 10 executed cases
    if (!opts.quiet && executedInThisRun % 10 === 0) {
      const projRest = projectedTokens(
        history,
        runList.length - i - 1,
        quota.trials,
        quota.marginPct,
      );

      const p = opts.cfg.pacer;

      console.error(
        `[quota] ${fmt(actualTokens)} tokens actual · projected total ${fmt(actualTokens + projRest)} / ${fmt(quota.maxTokens)} · rpm ${p?.rpm() ?? 0}/${quota.maxRpm} · tpm ${fmt(p?.tpm() ?? 0)}/${fmt(quota.maxTpm)} · cost ${pricing ? `$${actualCost.toFixed(4)} actual` : "UNKNOWN"}`,
      );

      if (actualTokens + projRest > quota.maxTokens) {
        console.error(
          "  ⚠ projected usage exceeds budget — will STOP before the next case",
        );
      }
    }
  }

  /* ---------- judge + reports (unchanged policy: BLOCKED ≠ faked) ---------- */

  let judgeNote: string | undefined;

  try {
    const judge = await runJudge(results, opts.pyBin);

    if (!judge.available) {
      judgeNote = `BLOCKED — ${judge.reason}`;
    } else {
      let merged = 0;

      for (const r of results) {
        const j = judge.results[r.caseId];

        if (!j) continue;

        for (const [metric, m] of Object.entries(j)) {
          const threshold = (m.score ?? 0) > 1 ? 3.5 : 0.5;

          r.grades.push({
            metric,
            score: m.score,
            passed:
              m.status === "ok" && m.score != null && m.score >= threshold,
            reason: m.reason,
            source: "deepeval",
          });
        }

        merged += 1;
      }

      judgeNote = `ok — judged ${merged} cases`;
    }
  } catch (e) {
    judgeNote = `BLOCKED — judge crashed: ${String(e).slice(0, 200)}`;
  }

  const baseline =
    opts.baselinePath && existsSync(opts.baselinePath)
      ? (JSON.parse(readFileSync(opts.baselinePath, "utf8")) as BaselineReport)
      : undefined;

  let card: Scorecard;

  try {
    card = buildScorecard(results, {
      model: opts.cfg.model,
      provider: opts.cfg.provider,
      baseline,
    });

    card.quota = {
      plan: usage?.plan ?? null,
      balance: usage?.balance ?? null,
      accountTokens: usage?.totalTokens ?? null,
      runBudgetTokens: quota.maxTokens,
      runActualTokens: actualTokens,
      projectedFullRunTokens: projectedTokens(
        history,
        selected.length,
        quota.trials,
        quota.marginPct,
      ),
      runActualCostUsd: pricing ? actualCost : null,
      projectedFullRunCostUsd: projectedCost(
        history,
        selected.length,
        quota.trials,
        quota.marginPct,
        pricing,
      ),
      maxRpm: quota.maxRpm,
      maxTpm: quota.maxTpm,
      rpmLimitOfficial: 50,
      tpmLimitOfficial: 2_000_000,
      trials: quota.trials,
      pricingSource,
      status: stoppedEarly ? "WOULD EXCEED SAFE BUDGET" : "SAFE",
    };

    card.stoppedEarly = stoppedEarly;

    const full = {
      scorecard: card,
      cases: results,
    };

    writeFileSync(
      join("eval", "reports", "latest.json"),
      JSON.stringify(full, null, 2),
    );

    copyFileSync(
      join("eval", "reports", "latest.json"),
      join(dir, "report.json"),
    );

    writeFileSync(join(dir, "report.html"), renderHtml(card, results));

    copyFileSync(
      join(dir, "report.html"),
      join("eval", "reports", "latest.html"),
    );

    const csvHeader =
      "case_id,title,category,status,severity,root_cause,duration_ms,tokens_in,tokens_out,cost_usd,retries";

    const csv = [
      csvHeader,
      ...results.map((r) =>
        [
          r.caseId,
          r.title,
          r.category,
          r.status,
          r.severity ?? "",
          r.rootCause ?? "",
          Math.round(r.durationMs),
          r.tokens.input ?? "",
          r.tokens.output ?? "",
          r.costUsd ?? "",
          r.retries ?? 0,
        ]
          .map(csvEscape)
          .join(","),
      ),
    ].join("\n");

    writeFileSync(join("eval", "reports", "latest.csv"), csv);

    writeFileSync(
      join("eval", "reports", "summary.json"),
      JSON.stringify(card, null, 2),
    );

    if (!opts.quiet) {
      try {
        renderScorecard(card, judgeNote);
      } catch {}
    }
  } catch (e) {
    console.error(
      `report generation failed (raw results preserved in ${jsonl}):`,
      e,
    );

    card = buildScorecard(results, {
      model: opts.cfg.model,
      provider: opts.cfg.provider,
    });
  }

  if (card.severities.P0 > 0) {
    process.exitCode = 2;
  } else if (card.failed > 0) {
    process.exitCode = 1;
  } else if (
    card.passed === 0 &&
    results.every(
      (r) => r.status === "blocked" && !r.blockedReason?.startsWith("SKIPPED"),
    )
  ) {
    process.exitCode = 3;
  }

  return card;
}
