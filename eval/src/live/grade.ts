import type { CaseInput } from "../types.js";

/*
 * LIVE latency budget. Real turns include network + model + tools,
 * which land at 1.3-2.7s. Offline budgets do NOT apply here.
 */
const LIVE_DEFAULT_LATENCY_BUDGET_MS = 6000;

export type CaseReport = {
  id: string;

  title: string;

  category: string;

  passed: boolean;

  reasons: string[];

  utterances: string[];

  turns: Array<{
    utterance: string;

    transcript: string;

    durationMs: number;

    functionCalls: Array<{ name: string; args: unknown }>;

    toolResults: Array<{
      ok: boolean;

      summary: string;

      error?: string;
    }>;
  }>;

  toolsCalled: string[];

  worstTurnMs: number;

  usage: { input: number; output: number };
};

export type LiveTurn = CaseReport["turns"][number];

export type LiveCaseGrade = {
  passed: boolean;

  reasons: string[];

  toolSelection: boolean;

  taskSuccess: boolean;

  responseQuality: boolean;

  reliable: boolean;

  withinLatency: boolean;

  worstTurnMs: number;
};

export function gradeLiveCase(
  testCase: CaseInput & { id: string; title: string },
  turns: LiveTurn[],
): LiveCaseGrade {
  const expect = testCase.expect ?? {};

  const reasons: string[] = [];

  const calledNames = turns.flatMap((turn: LiveTurn) =>
    turn.functionCalls.map((call: { name: string }) => call.name),
  );

  const allToolResults = turns.flatMap((turn: LiveTurn) => turn.toolResults);

  const transcripts = turns.map((turn: LiveTurn) => turn.transcript.trim());

  // ------------------------------------------------------------
  // TOOL SELECTION
  // ------------------------------------------------------------
  let toolSelection = true;

  if (expect.tools && expect.tools.length > 0) {
    const hasAny = expect.tools.some((tool: string) =>
      calledNames.includes(tool),
    );

    if (!hasAny) {
      toolSelection = false;

      reasons.push(
        `expected one of [${expect.tools.join(", ")}] but the model called ` +
          `[${calledNames.join(", ") || "none"}]`,
      );
    }
  }

  if (expect.notTools && expect.notTools.length > 0) {
    const bad = calledNames.filter((tool: string) =>
      expect.notTools?.includes(tool),
    );

    if (bad.length > 0) {
      toolSelection = false;

      reasons.push(`unnecessary tool call(s): ${bad.join(", ")}`);
    }
  }

  // ------------------------------------------------------------
  // TASK SUCCESS
  // ------------------------------------------------------------
  let taskSuccess = true;

  const expectFailure =
    (expect.summaryContains ?? []).some(
      (needle: string) =>
        needle.includes("couldn't") ||
        needle.includes("not be empty") ||
        needle.includes("what should i copy"),
    ) || testCase.category === "failure";

  const failing = allToolResults.filter((result) => !result.ok);

  if (!expectFailure && failing.length > 0) {
    const allGraceful = failing.every(
      (result: { error?: string }) => result.error === "tool-error",
    );

    if (!(allGraceful && testCase.category === "invalid")) {
      taskSuccess = false;

      reasons.push(
        `tool failed: ${failing[0]?.summary ?? failing[0]?.error ?? "unknown"}`,
      );
    }
  }

  // ------------------------------------------------------------
  // RESPONSE QUALITY
  // ------------------------------------------------------------
  let responseQuality = true;

  if (!expect.tools || expect.tools.length === 0) {
    const spoke = transcripts.some((text: string) => text.length > 0);

    if (!spoke) {
      responseQuality = false;

      reasons.push("model produced an empty reply (no transcript)");
    }
  } else {
    const summaries = allToolResults
      .map((result: { summary: string }) => result.summary.toLowerCase())
      .join(" \n ");

    const spoken = transcripts.join(" \n ").toLowerCase();

    const haystack = `${summaries} \n ${spoken}`;

    for (const needle of expect.summaryContains ?? []) {
      if (!haystack.includes(needle.toLowerCase())) {
        responseQuality = false;

        reasons.push(`reply missing "${needle}"`);

        break;
      }
    }

    for (const needle of expect.summaryNotContains ?? []) {
      if (haystack.includes(needle.toLowerCase())) {
        responseQuality = false;

        reasons.push(`reply contains forbidden "${needle}"`);

        break;
      }
    }

    if (/undefined|nan|\[object/i.test(spoken)) {
      responseQuality = false;

      reasons.push("reply contains leaked internals (undefined/NaN)");
    }
  }

  // ------------------------------------------------------------
  // RELIABILITY
  // ------------------------------------------------------------
  let reliable = true;

  if (allToolResults.some((result) => result.error === "internal-error")) {
    reliable = false;

    reasons.push("internal-error in the pipeline");
  }

  // ------------------------------------------------------------
  // LATENCY
  // ------------------------------------------------------------
  const budget = LIVE_DEFAULT_LATENCY_BUDGET_MS;

  const worstTurnMs = Math.max(
    0,
    ...turns.map((turn: LiveTurn) => turn.durationMs),
  );

  const withinLatency = worstTurnMs <= budget;

  if (!withinLatency) {
    reasons.push(
      `latency ${Math.round(worstTurnMs)}ms exceeded live budget ${budget}ms`,
    );
  }

  const passed =
    toolSelection &&
    taskSuccess &&
    responseQuality &&
    reliable &&
    withinLatency;

  return {
    passed,
    reasons,
    toolSelection,
    taskSuccess,
    responseQuality,
    reliable,
    withinLatency,
    worstTurnMs,
  };
}
