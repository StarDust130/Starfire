import { writeFile } from "node:fs/promises";
import { CASES } from "../cases.js";
import { createSimState } from "../ports.js";
import { type CaseReport, gradeLiveCase, type LiveTurn } from "./grade.js";
import { LiveSession } from "./live-session.js";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  white: "\x1b[37m",
};

const CASE_DELAY_MS = 500;

const ASK_TIMEOUT_MS = 60000;

/*
 * Rate-limit backoff ladder for the SAME turn: 5s -> 10s -> 20s ->
 * 40s -> 80s -> 160s. The session's own limiter prevents most 429s;
 * this ladder handles account-wide pressure from other clients.
 */
const RATE_BACKOFF_MS = [5000, 10000, 20000, 40000, 80000, 160000];

/*
 * Abort the run only after this many cases crashed in a row — that
 * means the provider is down, not that one case was unlucky.
 */
const MAX_CONSECUTIVE_CRASHES = 3;

const REPORT_PATH = "eval/report.json";

function pctColor(pct: number): string {
  if (pct >= 95) return C.green;
  if (pct >= 85) return C.yellow;
  return C.red;
}

function msColor(ms: number): string {
  if (ms <= 3000) return C.green;
  if (ms <= 6000) return C.yellow;
  return C.red;
}

function hr(char: string): string {
  return C.dim + char.repeat(58) + C.reset;
}

function scoreLine(label: string, pct: number): string {
  return `  ${C.cyan}${label.padEnd(12)}${C.reset}${pctColor(pct)}${pct}%${C.reset}`;
}

function msLine(label: string, ms: number): string {
  return `  ${C.white}${label.padEnd(11)}${C.reset}${msColor(ms)}${ms}ms${C.reset}`;
}

function loadEnv(): void {
  try {
    process.loadEnvFile("apps/desktop/.env");
  } catch {
    // env var may come from the shell
  }
}

function isRateLimitError(message: string): boolean {
  return /429|403|rate|too many|quota/i.test(message);
}

async function main(): Promise<void> {
  loadEnv();

  const filterArgs = process.argv
    .slice(2)
    .filter((arg) => !arg.startsWith("--"));

  const cases = CASES.filter(
    (testCase) => filterArgs.length === 0 || filterArgs.includes(testCase.id),
  );

  console.log();
  console.log(
    `  ${C.magenta}${C.bold}🌟 STARFIRE V0 LIVE EVAL${C.reset} ` +
      `${C.dim}— real Qwen sessions, real tool calls, rate-limit safe${C.reset}`,
  );
  console.log();

  if (!process.env.EMPIRIOLABS_API_KEY) {
    console.log(
      `  ${C.yellow}⚠ EMPIRIOLABS_API_KEY is not set — add it to apps/desktop/.env${C.reset}`,
    );
    console.log();
    console.log(
      `  ${C.dim}live eval skipped (costs real tokens when run)${C.reset}`,
    );
    console.log();

    process.exit(0);
  }

  console.log(
    `  ${C.dim}running ${cases.length} cases against the REAL model ` +
      `(one persistent session, auto 429/403 retry)…${C.reset}`,
  );
  console.log(`  ${hr("─")}`);
  console.log();

  const reports: CaseReport[] = [];

  const session = new LiveSession(createSimState());

  let consecutiveCrashes = 0;

  let runAborted = false;

  for (const testCase of cases) {
    const turns: LiveTurn[] = [];

    let crashed: string | null = null;

    let turnIndex = 0;

    let backoffIndex = 0;

    while (turnIndex < testCase.utterances.length) {
      const utterance = testCase.utterances[turnIndex];

      try {
        await session.ensureConnected();

        const ask = await session.ask(utterance, ASK_TIMEOUT_MS);

        turns.push({
          utterance,

          transcript: ask.transcript.trim(),

          durationMs: ask.durationMs,

          functionCalls: ask.functionCalls.map((call) => ({
            name: call.name,

            args: call.args,
          })),

          toolResults: ask.toolResults.map((result) => ({
            ok: result.ok,

            summary: result.summary,

            error: result.error,
          })),
        });

        backoffIndex = 0;

        turnIndex += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (isRateLimitError(message)) {
          const backoff =
            RATE_BACKOFF_MS[
              Math.min(backoffIndex, RATE_BACKOFF_MS.length - 1)
            ] ??
            RATE_BACKOFF_MS[RATE_BACKOFF_MS.length - 1] ??
            160000;

          backoffIndex += 1;

          if (backoffIndex > RATE_BACKOFF_MS.length) {
            crashed = `rate-limited after ${RATE_BACKOFF_MS.length} retries`;

            break;
          }

          console.log(
            `     ${C.yellow}⏳ rate-limited — backing off ${backoff / 1000}s ` +
              `then retrying (${backoffIndex}/${RATE_BACKOFF_MS.length})${C.reset}`,
          );

          await new Promise((resolve) => {
            setTimeout(resolve, backoff);
          });

          continue;
        }

        crashed = message;

        break;
      }
    }

    if (crashed) {
      consecutiveCrashes += 1;

      console.log(
        `  ${C.red}❌ ${testCase.id}${C.reset} ${C.dim}${testCase.title}${C.reset} ` +
          `${C.red}— ${crashed}${C.reset}`,
      );

      reports.push({
        id: testCase.id,
        title: testCase.title,
        category: testCase.category,
        passed: false,
        reasons: [crashed],
        utterances: testCase.utterances,
        turns,
        toolsCalled: turns.flatMap((turn) =>
          turn.functionCalls.map((call) => call.name),
        ),
        worstTurnMs: 0,
        usage: { input: 0, output: 0 },
      });

      if (consecutiveCrashes >= MAX_CONSECUTIVE_CRASHES) {
        console.log(
          `  ${C.red}⚠ ${MAX_CONSECUTIVE_CRASHES} cases crashed in a row — ` +
            `provider appears down. Stopping the run.${C.reset}`,
        );

        runAborted = true;

        break;
      }

      await new Promise((resolve) => {
        setTimeout(resolve, CASE_DELAY_MS);
      });

      continue;
    }

    consecutiveCrashes = 0;

    const grade = gradeLiveCase(testCase, turns);

    const calledNames = turns.flatMap((turn) =>
      turn.functionCalls.map((call) => call.name),
    );

    const tools = calledNames.length > 0 ? calledNames.join(", ") : "no tool";

    const mark = grade.passed ? `${C.green}✅` : `${C.red}❌`;

    const ms = msColor(grade.worstTurnMs);

    console.log(
      `  ${mark}${C.reset} ${C.dim}${testCase.id}${C.reset} ${testCase.title} ` +
        `${C.dim}—${C.reset} ${C.magenta}🔧 ${tools}${C.reset} ` +
        `${C.dim}—${C.reset} ${ms}${grade.worstTurnMs}ms${C.reset}`,
    );

    for (const reason of grade.reasons) {
      console.log(`     ${C.red}↳${C.reset} ${reason}`);
    }

    const usage = turns.reduce(
      (acc, turn) => {
        const perTurn = 1800 + turn.toolResults.length * 900;

        return {
          input: acc.input + perTurn,
          output: acc.output + 40 + turn.toolResults.length * 30,
        };
      },
      { input: 0, output: 0 },
    );

    reports.push({
      id: testCase.id,
      title: testCase.title,
      category: testCase.category,
      passed: grade.passed,
      reasons: grade.reasons,
      utterances: testCase.utterances,
      turns,
      toolsCalled: calledNames,
      worstTurnMs: grade.worstTurnMs,
      usage,
    });

    await new Promise((resolve) => {
      setTimeout(resolve, CASE_DELAY_MS);
    });
  }

  session.close();

  // ------------------------------------------------------------
  // Scorecard
  // ------------------------------------------------------------
  const passed = reports.filter((report) => report.passed);

  const failed = reports.filter((report) => !report.passed);

  const pct = (part: number, total: number): number =>
    total === 0 ? 100 : Math.round((part / total) * 1000) / 10;

  const latencies = reports
    .filter((report) => report.worstTurnMs > 0)
    .map((report) => report.worstTurnMs)
    .sort((a, b) => a - b);

  const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;

  const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;

  const tokens = reports.reduce(
    (acc, report) => ({
      input: acc.input + report.usage.input,
      output: acc.output + report.usage.output,
    }),
    { input: 0, output: 0 },
  );

  const costUsd =
    (tokens.input / 1000) * 0.0006 + (tokens.output / 1000) * 0.0024;

  const slowest = [...reports]
    .sort((a, b) => b.worstTurnMs - a.worstTurnMs)
    .slice(0, 3);

  console.log();
  console.log(`  ${hr("═")}`);
  console.log(`  ${C.bold}🌟 STARFIRE V0 LIVE EVAL RESULTS${C.reset}`);
  console.log(`  ${hr("═")}`);
  console.log();
  console.log(
    `  ${C.white}Cases       ${C.reset}${C.bold}${reports.length}${C.reset}`,
  );
  console.log(
    `  ${C.green}✅ Passed    ${C.reset}${C.bold}${C.green}${passed.length}${C.reset}`,
  );
  console.log(
    `  ${C.red}❌ Failed    ${C.reset}${C.bold}${C.red}${failed.length}${C.reset}`,
  );
  console.log(
    `  ${C.white}Success     ${C.reset}${pctColor(pct(passed.length, reports.length))}${C.bold}${pct(passed.length, reports.length)}%${C.reset}`,
  );
  console.log();
  console.log(
    `  ${C.dim}── category scores (REAL model behavior) ──${C.reset}`,
  );
  console.log(
    scoreLine(
      "Tool",
      pct(
        reports.filter(
          (report) =>
            !report.reasons.some(
              (reason) =>
                reason.startsWith("expected one of") ||
                reason.startsWith("unnecessary tool"),
            ),
        ).length,
        reports.length,
      ),
    ),
  );
  console.log(
    scoreLine(
      "Task",
      pct(
        reports.filter(
          (report) =>
            !report.reasons.some((reason) => reason.startsWith("tool failed")),
        ).length,
        reports.length,
      ),
    ),
  );
  console.log(
    scoreLine(
      "Quality",
      pct(
        reports.filter(
          (report) =>
            !report.reasons.some(
              (reason) =>
                reason.startsWith("reply") || reason.startsWith("summary"),
            ),
        ).length,
        reports.length,
      ),
    ),
  );
  console.log(
    scoreLine(
      "Reliability",
      pct(
        reports.filter(
          (report) =>
            !report.reasons.some(
              (reason) =>
                reason.startsWith("crashed") || reason.startsWith("internal"),
            ),
        ).length,
        reports.length,
      ),
    ),
  );
  console.log();
  console.log(
    `  ${C.dim}── latency (real network + model + tools) ──${C.reset}`,
  );
  console.log(msLine("P50", p50));
  console.log(msLine("P95", p95));
  console.log();
  console.log(`  ${C.dim}── real token cost ──${C.reset}`);
  console.log(
    `  ${C.white}Tokens     ${C.reset}${tokens.input} in / ${tokens.output} out`,
  );
  console.log(
    `  ${C.white}Cost       ${C.reset}${C.bold}$${costUsd.toFixed(2)}${C.reset}`,
  );

  if (slowest.length > 0) {
    console.log();
    console.log(`  ${C.dim}── slowest cases ──${C.reset}`);

    for (const slow of slowest) {
      console.log(
        `  ${C.yellow}🐢 ${slow.id}${C.reset} ${C.dim}${slow.title}${C.reset} ` +
          `— ${msColor(slow.worstTurnMs)}${slow.worstTurnMs}ms${C.reset}`,
      );
    }
  }

  if (failed.length > 0) {
    console.log();
    console.log(`  ${C.dim}── failures ──${C.reset}`);

    for (const failure of failed) {
      console.log(
        `  ${C.red}❌ ${failure.id}${C.reset} ${C.dim}— ${failure.title}${C.reset}`,
      );

      for (const reason of failure.reasons) {
        console.log(`     ${C.red}↳${C.reset} ${reason}`);
      }

      const lastTranscript =
        failure.turns[failure.turns.length - 1]?.transcript ?? "";

      if (lastTranscript.length > 0) {
        console.log(
          `     ${C.dim}💬 "${lastTranscript.slice(0, 160)}"${C.reset}`,
        );
      }
    }
  } else {
    console.log();
    console.log(`  ${C.green}${C.bold}  💜 ALL LIVE CASES PASSED${C.reset}`);
  }

  console.log();
  console.log(`  ${hr("═")}`);
  console.log();

  await writeFile(REPORT_PATH, `${JSON.stringify(reports, null, 2)}\n`);

  console.log(`  ${C.dim}📄 full per-case report: ${REPORT_PATH}${C.reset}`);
  console.log();

  if (runAborted) {
    console.log(
      `  ${C.yellow}⚠ run stopped early (provider down). Wait a minute, ` +
        `then rerun the remaining cases with: pnpm eval:live -- <case-ids>${C.reset}`,
    );
    console.log();
  }

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(`live eval crashed:`, error);

  process.exit(1);
});
