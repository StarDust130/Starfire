import { runAll } from "./runner.ts";

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

function pctColor(pct: number): string {
  if (pct >= 95) return C.green;
  if (pct >= 85) return C.yellow;
  return C.red;
}

function msColor(ms: number): string {
  if (ms <= 800) return C.green;
  if (ms <= 1500) return C.yellow;
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

async function main(): Promise<void> {
  const quiet = process.argv.includes("--quiet");

  console.log();
  console.log(
    `  ${C.magenta}${C.bold}🌟 STARFIRE V0 EVAL${C.reset} ${C.dim}— live user-simulation${C.reset}`,
  );
  console.log(`  ${hr("─")}`);
  console.log();

  const result = await runAll((progress) => {
    const { result: r } = progress;

    if (quiet) {
      return;
    }

    const mark = r.passed ? `${C.green}✅` : `${C.red}❌`;

    const ms = msColor(r.durationMs);

    console.log(
      `  ${mark}${C.reset} ${C.dim}${r.id}${C.reset} ${r.title} ` +
        `${C.dim}—${C.reset} ${ms}${r.durationMs}ms${C.reset}`,
    );

    if (!r.passed) {
      for (const reason of r.reasons) {
        console.log(`     ${C.red}↳${C.reset} ${reason}`);
      }
    }
  });

  console.log();
  console.log(`  ${hr("═")}`);
  console.log(`  ${C.bold}🌟 STARFIRE V0 EVAL RESULTS${C.reset}`);
  console.log(`  ${hr("═")}`);
  console.log();
  console.log(
    `  ${C.white}Cases       ${C.reset}${C.bold}${result.cases}${C.reset}`,
  );
  console.log(
    `  ${C.green}✅ Passed    ${C.reset}${C.bold}${C.green}${result.passed}${C.reset}`,
  );
  console.log(
    `  ${C.red}❌ Failed    ${C.reset}${C.bold}${C.red}${result.failed}${C.reset}`,
  );
  console.log(
    `  ${C.white}Success     ${C.reset}${pctColor(result.successPct)}${C.bold}${result.successPct}%${C.reset}`,
  );
  console.log();
  console.log(`  ${C.dim}── category scores ──${C.reset}`);
  console.log(scoreLine("Tool", result.toolSelectionPct));
  console.log(scoreLine("Task", result.taskSuccessPct));
  console.log(scoreLine("Quality", result.qualityPct));
  console.log(scoreLine("Reliability", result.reliabilityPct));
  console.log();
  console.log(
    `  ${C.dim}live E2E adds network+VAD (~300-700ms) — see ⏱ logs in pnpm dev${C.reset}`,
  );
  console.log(msLine("P50", result.latencyP50));
  console.log(msLine("P95", result.latencyP95));

  if (result.latencyBudgetViolations > 0) {
    console.log(
      `  ${C.yellow}⚠ budget violations: ${result.latencyBudgetViolations}${C.reset}`,
    );
  }

  console.log();
  console.log(`  ${C.dim}── cost (simulated tokens) ──${C.reset}`);
  console.log(
    `  ${C.white}Tokens     ${C.reset}${result.tokens.input} in / ${result.tokens.output} out`,
  );
  console.log(
    `  ${C.white}Cost       ${C.reset}${C.bold}$${result.costUsd.toFixed(2)}${C.reset}`,
  );

  if (result.slowest.length > 0) {
    console.log();
    console.log(`  ${C.dim}── slowest cases ──${C.reset}`);

    for (const slow of result.slowest) {
      console.log(
        `  ${C.yellow}🐢 ${slow.id}${C.reset} ${C.dim}${slow.title}${C.reset} ` +
          `— ${msColor(slow.durationMs)}${slow.durationMs}ms${C.reset}`,
      );
    }
  }

  if (result.failures.length > 0) {
    console.log();
    console.log(`  ${C.dim}── failures ──${C.reset}`);

    for (const failure of result.failures) {
      console.log(
        `  ${C.red}❌ ${failure.id}${C.reset} ${C.dim}— ${failure.title}${C.reset}`,
      );

      for (const reason of failure.reasons) {
        console.log(`     ${C.red}↳${C.reset} ${reason}`);
      }
    }
  } else {
    console.log();
    console.log(`  ${C.green}${C.bold}  💜 ALL CASES PASSED${C.reset}`);
  }

  console.log();
  console.log(`  ${hr("═")}`);
  console.log();

  process.exit(result.failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(`${C.red}eval crashed:${C.reset}`, error);

  process.exit(1);
});
