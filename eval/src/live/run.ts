import { CASES } from "../cases.js";
import { createSimState } from "../ports.js";
import { gradeLiveCase } from "./grade.js";
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
    // no .env — env var may come from the shell
  }
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
      `${C.dim}— real Qwen sessions, real tool calls${C.reset}`,
  );
  console.log();

  if (!process.env.EMPIRIOLABS_API_KEY) {
    console.log(
      `  ${C.yellow}⚠ EMPIRIOLABS_API_KEY is not set — add it to apps/desktop/.env${C.reset}`,
    );
    console.log(
      `  ${C.dim}live eval skipped (costs real tokens when run)${C.reset}`,
    );
    console.log();

    process.exit(0);
  }

  console.log(
    `  ${C.dim}running ${cases.length} cases against the REAL model ` +
      `(≈ $0.10-0.30)…${C.reset}`,
  );
  console.log(`  ${hr("─")}`);
  console.log();

  const results: Array<{
    id: string;

    title: string;

    passed: boolean;

    reasons: string[];

    worstTurnMs: number;

    toolsCalled: string[];

    transcriptSample: string;

    usage: { input: number; output: number };
  }> = [];

  for (const testCase of cases) {
    const asks: Array<Awaited<ReturnType<LiveSession["ask"]>>> = [];

    let crashed: string | null = null;

    const session = new LiveSession(createSimState());

    try {
      await session.connect();

      for (const utterance of testCase.utterances) {
        asks.push(await session.ask(utterance, ASK_TIMEOUT_MS));
      }
    } catch (error) {
      crashed = error instanceof Error ? error.message : String(error);
    } finally {
      session.close();
    }

    if (crashed) {
      console.log(
        `  ${C.red}❌ ${testCase.id}${C.reset} ${C.dim}${testCase.title}${C.reset} ` +
          `${C.red}— crashed: ${crashed}${C.reset}`,
      );

      results.push({
        id: testCase.id,
        title: testCase.title,
        passed: false,
        reasons: [`crashed: ${crashed}`],
        worstTurnMs: 0,
        toolsCalled: [],
        transcriptSample: "",
        usage: { input: 0, output: 0 },
      });

      await new Promise((resolve) => {
        setTimeout(resolve, CASE_DELAY_MS);
      });

      continue;
    }

    const grade = gradeLiveCase(testCase, asks);

    const calledNames = asks.flatMap((ask) =>
      ask.functionCalls.map((call) => call.name),
    );

    const tools = calledNames.length > 0 ? calledNames.join(", ") : "no tool";

    const mark = grade.passed ? `${C.green}✅` : `${C.red}❌`;

    const ms = msColor(grade.worstTurnMs);

    const toolInfo = `${C.magenta}🔧 ${tools}${C.reset}`;

    console.log(
      `  ${mark}${C.reset} ${C.dim}${testCase.id}${C.reset} ${testCase.title} ` +
        `${C.dim}—${C.reset} ${toolInfo} ${C.dim}—${C.reset} ${ms}${grade.worstTurnMs}ms${C.reset}`,
    );

    for (const reason of grade.reasons) {
      console.log(`     ${C.red}↳${C.reset} ${reason}`);
    }

    const lastTranscript = [...asks]
      .reverse()
      .map((ask) => ask.transcript.trim())
      .find((text) => text.length > 0);

    const usage = asks.reduce(
      (acc, ask) => ({
        input: acc.input + ask.usage.input,
        output: acc.output + ask.usage.output,
      }),
      { input: 0, output: 0 },
    );

    results.push({
      id: testCase.id,
      title: testCase.title,
      passed: grade.passed,
      reasons: grade.reasons,
      worstTurnMs: grade.worstTurnMs,
      toolsCalled: calledNames,
      transcriptSample: (lastTranscript ?? "").slice(0, 160),
      usage,
    });

    await new Promise((resolve) => {
      setTimeout(resolve, CASE_DELAY_MS);
    });
  }

  // ------------------------------------------------------------
  // Scorecard
  // ------------------------------------------------------------
  const passed = results.filter((result) => result.passed);

  const failed = results.filter((result) => !result.passed);

  const pct = (part: number, total: number): number =>
    total === 0 ? 100 : Math.round((part / total) * 1000) / 10;

  const latencies = results
    .map((result) => result.worstTurnMs)
    .sort((a, b) => a - b);

  const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;

  const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;

  const tokens = results.reduce(
    (acc, result) => ({
      input: acc.input + result.usage.input,
      output: acc.output + result.usage.output,
    }),
    { input: 0, output: 0 },
  );

  const costUsd =
    (tokens.input / 1000) * 0.0006 + (tokens.output / 1000) * 0.0024;

  const slowest = [...results]
    .sort((a, b) => b.worstTurnMs - a.worstTurnMs)
    .slice(0, 3);

  console.log();
  console.log(`  ${hr("═")}`);
  console.log(`  ${C.bold}🌟 STARFIRE V0 LIVE EVAL RESULTS${C.reset}`);
  console.log(`  ${hr("═")}`);
  console.log();
  console.log(
    `  ${C.white}Cases       ${C.reset}${C.bold}${results.length}${C.reset}`,
  );
  console.log(
    `  ${C.green}✅ Passed    ${C.reset}${C.bold}${C.green}${passed.length}${C.reset}`,
  );
  console.log(
    `  ${C.red}❌ Failed    ${C.reset}${C.bold}${C.red}${failed.length}${C.reset}`,
  );
  console.log(
    `  ${C.white}Success     ${C.reset}${pctColor(pct(passed.length, results.length))}${C.bold}${pct(passed.length, results.length)}%${C.reset}`,
  );
  console.log();
  console.log(
    `  ${C.dim}── category scores (REAL model behavior) ──${C.reset}`,
  );
  console.log(
    scoreLine(
      "Tool",
      pct(
        results.filter(
          (result) =>
            !result.reasons.some(
              (reason) =>
                reason.startsWith("expected one of") ||
                reason.startsWith("unnecessary tool"),
            ),
        ).length,
        results.length,
      ),
    ),
  );
  console.log(
    scoreLine(
      "Task",
      pct(
        results.filter(
          (result) =>
            !result.reasons.some((reason) => reason.startsWith("tool failed")),
        ).length,
        results.length,
      ),
    ),
  );
  console.log(
    scoreLine(
      "Quality",
      pct(
        results.filter(
          (result) =>
            !result.reasons.some(
              (reason) =>
                reason.startsWith("reply") || reason.startsWith("summary"),
            ),
        ).length,
        results.length,
      ),
    ),
  );
  console.log(
    scoreLine(
      "Reliability",
      pct(
        results.filter(
          (result) =>
            !result.reasons.some(
              (reason) =>
                reason.startsWith("crashed") || reason.startsWith("internal"),
            ),
        ).length,
        results.length,
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

      if (failure.transcriptSample.length > 0) {
        console.log(`     ${C.dim}💬 "${failure.transcriptSample}"${C.reset}`);
      }
    }
  } else {
    console.log();
    console.log(`  ${C.green}${C.bold}  💜 ALL LIVE CASES PASSED${C.reset}`);
  }

  console.log();
  console.log(`  ${hr("═")}`);
  console.log();

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(`live eval crashed:`, error);

  process.exit(1);
});
