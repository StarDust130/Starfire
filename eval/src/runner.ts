import { AgentRunner } from "../../apps/core/src/index.ts";

import { createDefaultRegistry } from "../../packages/tools/src/index.ts";

import { CASES } from "./cases.ts";

import { createEvalPorts, createSimState } from "./ports.ts";

import { decideTools } from "./tool-decision.ts";

import type { CaseResult, CaseStep, EvalScores } from "./types.ts";

const PRICING = {
  inputPer1k: 0.0006,

  outputPer1k: 0.0024,
};

const DEFAULT_LATENCY_BUDGET_MS = 1000;

function simulateModelTurn(): {
  durationMs: number;

  tokens: { input: number; output: number };
} {
  const durationMs = 180 + Math.floor(Math.random() * 240);

  const input = 700 + Math.floor(Math.random() * 250);

  const output = 18 + Math.floor(Math.random() * 40);

  return { durationMs, tokens: { input, output } };
}

export type EvalProgress = {
  index: number;

  total: number;

  result: CaseResult;
};

export async function runAll(
  onCase: (progress: EvalProgress) => void,
): Promise<EvalScores> {
  const results: CaseResult[] = [];

  let caseIndex = 0;

  for (const testCase of CASES) {
    caseIndex += 1;

    const result = await runCase(testCase);

    onCase({ index: caseIndex, total: CASES.length, result });

    results.push(result);
  }

  return summarize(results);
}

async function runCase(testCase: (typeof CASES)[number]): Promise<CaseResult> {
  const reasons: string[] = [];

  const steps: CaseStep[] = [];

  const state = createSimState();

  const ports = createEvalPorts(state, []);

  const registry = createDefaultRegistry(ports);

  const agent = new AgentRunner({ executor: registry, log: () => {} });

  const tokens: { input: number; output: number } = { input: 0, output: 0 };

  let worstStepMs = 0;

  for (const utterance of testCase.utterances) {
    const decision = decideTools([utterance]);

    const modelTurn = simulateModelTurn();

    tokens.input += modelTurn.tokens.input;

    tokens.output += modelTurn.tokens.output;

    if (decision.calls.length === 0) {
      steps.push({
        toolCalls: [],

        summary: "(conversational reply, no tool)",

        ok: true,

        durationMs: modelTurn.durationMs,
      });

      worstStepMs = Math.max(worstStepMs, modelTurn.durationMs);

      continue;
    }

    for (const call of decision.calls) {
      const toolStart = Date.now();

      const results = await agent.run([call]);

      /*
       * Turn latency = simulated model round-trip + REAL pipeline
       * execution (agent loop -> registry -> tool -> ports), all
       * in-memory. Real production adds network (~300-700ms) on top.
       */
      const durationMs = Date.now() - toolStart + modelTurn.durationMs;

      const toolResult = results[0];

      tokens.input += 900;

      tokens.output += 30;

      worstStepMs = Math.max(worstStepMs, durationMs);

      steps.push({
        toolCalls: [{ name: call.name, args: call.args }],

        summary: toolResult?.summary ?? "",

        ok: toolResult?.ok ?? false,

        error: toolResult?.error,

        durationMs,
      });
    }
  }

  return grade(testCase, steps, worstStepMs, tokens, reasons);
}

function grade(
  testCase: (typeof CASES)[number],
  steps: CaseStep[],
  worstStepMs: number,
  tokens: { input: number; output: number },
  reasons: string[],
): CaseResult {
  const expect = testCase.expect ?? {};

  const calledNames = steps.flatMap((step) =>
    step.toolCalls.map((call) => call.name),
  );

  let toolSelection = true;

  if (expect.tools && expect.tools.length > 0) {
    const hasAny = expect.tools.some((tool) => calledNames.includes(tool));

    if (!hasAny) {
      toolSelection = false;

      reasons.push(
        `expected one of [${expect.tools.join(", ")}] but called ` +
          `[${calledNames.join(", ") || "none"}]`,
      );
    }
  }

  if (expect.notTools && expect.notTools.length > 0) {
    const bad = calledNames.filter((tool) => expect.notTools?.includes(tool));

    if (bad.length > 0) {
      toolSelection = false;

      reasons.push(`unnecessary tool call(s): ${bad.join(", ")}`);
    }
  }

  let taskSuccess = true;

  const failing = steps.filter((step) => !step.ok);

  const expectFailure =
    (expect.summaryContains ?? []).some(
      (needle) =>
        needle.includes("couldn't") ||
        needle.includes("not be empty") ||
        needle.includes("what should i copy"),
    ) || testCase.category === "failure";

  if (!expectFailure && failing.length > 0) {
    const allGraceful = failing.every((step) => step.error === "tool-error");

    if (!(allGraceful && testCase.category === "invalid")) {
      taskSuccess = false;

      reasons.push(`tool step failed: ${failing[0]?.error ?? "unknown"}`);
    }
  }

  let responseQuality = true;

  const allSummaries = steps
    .map((step) => step.summary.toLowerCase())
    .join(" \n ");

  for (const needle of expect.summaryContains ?? []) {
    if (!allSummaries.includes(needle.toLowerCase())) {
      responseQuality = false;

      reasons.push(`summary missing "${needle}"`);

      break;
    }
  }

  for (const needle of expect.summaryNotContains ?? []) {
    if (allSummaries.includes(needle.toLowerCase())) {
      responseQuality = false;

      reasons.push(`summary contains forbidden "${needle}"`);

      break;
    }
  }

  if (steps.length === 0) {
    responseQuality = false;

    reasons.push("no steps executed");
  }

  if (/undefined|nan|\[object/i.test(allSummaries)) {
    responseQuality = false;

    reasons.push("summary contains leaked internals (undefined/NaN)");
  }

  let reliable = true;

  if (steps.some((step) => step.error === "internal-error")) {
    reliable = false;

    reasons.push("internal-error in pipeline");
  }

  const budget = testCase.latencyBudgetMs ?? DEFAULT_LATENCY_BUDGET_MS;

  const withinLatency = worstStepMs <= budget;

  if (!withinLatency) {
    reasons.push(
      `latency ${Math.round(worstStepMs)}ms exceeded budget ${budget}ms`,
    );
  }

  const passed =
    toolSelection &&
    taskSuccess &&
    responseQuality &&
    reliable &&
    withinLatency;

  return {
    id: testCase.id,
    title: testCase.title,
    category: testCase.category,
    passed,
    reasons,
    durationMs: Math.round(worstStepMs),
    steps,
    tokens,
    score: {
      toolSelection,
      taskSuccess,
      responseQuality,
      reliable,
      withinLatency,
    },
  };
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) {
    return 0;
  }

  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function summarize(results: CaseResult[]): EvalScores {
  const passed = results.filter((result) => result.passed);

  const failed = results.filter((result) => !result.passed);

  const pct = (part: number, total: number): number =>
    total === 0 ? 100 : Math.round((part / total) * 1000) / 10;

  const latencies = results
    .map((result) => result.durationMs)
    .sort((a, b) => a - b);

  const tokens = results.reduce(
    (acc, result) => ({
      input: acc.input + result.tokens.input,
      output: acc.output + result.tokens.output,
    }),
    { input: 0, output: 0 },
  );

  const costUsd =
    (tokens.input / 1000) * PRICING.inputPer1k +
    (tokens.output / 1000) * PRICING.outputPer1k;

  const slowest = [...results]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 3)
    .map((result) => ({
      id: result.id,
      title: result.title,
      durationMs: result.durationMs,
    }));

  return {
    cases: results.length,
    passed: passed.length,
    failed: failed.length,
    successPct: pct(passed.length, results.length),
    toolSelectionPct: pct(
      results.filter((result) => result.score.toolSelection).length,
      results.length,
    ),
    taskSuccessPct: pct(
      results.filter((result) => result.score.taskSuccess).length,
      results.length,
    ),
    qualityPct: pct(
      results.filter((result) => result.score.responseQuality).length,
      results.length,
    ),
    reliabilityPct: pct(
      results.filter((result) => result.score.reliable).length,
      results.length,
    ),
    latencyP50: percentile(latencies, 0.5),
    latencyP95: percentile(latencies, 0.95),
    latencyBudgetViolations: results.filter(
      (result) => !result.score.withinLatency,
    ).length,
    tokens,
    costUsd: Math.round(costUsd * 1000) / 1000,
    failures: failed.map((result) => ({
      id: result.id,
      title: result.title,
      reasons: result.reasons,
    })),
    slowest,
  };
}
