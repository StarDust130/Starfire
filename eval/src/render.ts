import type { Scorecard } from "./report.js";
import type { CaseResult } from "./types.js";

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const cc = (code: string, s: string): string =>
  useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
const bold = (s: string): string => cc("1", s);
const dim = (s: string): string => cc("2", s);
const red = (s: string): string => cc("31", s);
const green = (s: string): string => cc("32", s);
const yellow = (s: string): string => cc("33", s);
const blue = (s: string): string => cc("34", s);
const cyan = (s: string): string => cc("36", s);

function bar(pct: number, width = 24): string {
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * width);
  return `${"█".repeat(filled)}${dim("░".repeat(width - filled))}`;
}

// Collapse runs of identical BLOCKED lines so a no-key run stays readable.
let lastBlockedReason: string | null = null;
let suppressedBlocked = 0;

function flushSuppressed(): void {
  if (suppressedBlocked > 0) {
    console.log(
      dim(`   ⛔ … +${suppressedBlocked} more cases blocked (same reason)`),
    );
    suppressedBlocked = 0;
  }
}

export function renderCaseLine(
  i: number,
  total: number,
  r: CaseResult,
  verbose: boolean,
): void {
  if (r.status === "blocked") {
    const reason = r.blockedReason ?? "";
    if (reason === lastBlockedReason) {
      suppressedBlocked += 1;
      return;
    }
    flushSuppressed();
    lastBlockedReason = reason;
  } else {
    flushSuppressed();
    lastBlockedReason = null;
  }

  const num = blue(`[${String(i + 1).padStart(3, "0")}/${total}]`);
  const icon =
    r.status === "pass"
      ? green("✅")
      : r.status === "fail"
        ? red("❌")
        : blue("⛔");
  const dur = dim(`${(r.durationMs / 1000).toFixed(2)}s`);
  console.log(
    `${num} ${icon} ${bold(r.caseId)} ${r.title.slice(0, 70)} ${dur}`,
  );

  if (r.status === "blocked") {
    console.log(`   ${blue("⛔ BLOCKED")}: ${r.blockedReason}`);
    return;
  }

  const tools = r.toolCalls.map((t) => t.tool).join(", ") || "(none)";
  console.log(`   ${dim("📂")} ${r.category}  ${dim("🤖")} ${tools}`);
  if (verbose) {
    for (const t of r.toolCalls) {
      console.log(
        `      ${t.tool}  args=${JSON.stringify(t.parsedArgs)}  ok=${t.ok}${t.error ? ` err=${t.error}` : ""}`,
      );
      if (t.summary) console.log(dim(`        ↳ "${t.summary}"`));
    }
    console.log(`   ${dim("💬")} "${r.finalResponse}"`);
    console.log(
      dim(
        `   ⏱ model=${Math.round(r.latency.modelMs)}ms tools=${Math.round(r.latency.toolMs)}ms iters=${r.latency.llmIterations}`,
      ),
    );
    console.log(
      dim(
        `   🎯 tokens in=${r.tokens.input ?? "unknown"} out=${r.tokens.output ?? "unknown"} cost=${r.costUsd != null ? `$${r.costUsd.toFixed(5)}` : "unknown"}`,
      ),
    );
    for (const g of r.grades) {
      console.log(
        `   ${g.passed ? green("📊") : red("📊")} ${g.metric}: ${g.score}${g.source === "deepeval" ? " (deepeval)" : ""} — ${g.reason.slice(0, 110)}`,
      );
    }
  } else {
    const reply = r.finalResponse.replace(/\s+/g, " ").slice(0, 70);
    if (reply) console.log(`   ${dim("💬")} "${reply}"`);
  }

  if (r.status === "fail") {
    const sev =
      r.severity === "P0"
        ? red(`🔴 ${r.severity} CRITICAL`)
        : r.severity === "P1"
          ? red(`🔴 ${r.severity} HIGH`)
          : yellow(`🟠 ${r.severity}`);
    console.log(`   ${dim("🔍 root")}: ${r.rootCause}   ${sev}`);
    const firstFail = r.grades.find((g) => !g.passed);
    if (firstFail)
      console.log(`   ${dim("🧾")} ${firstFail.reason.slice(0, 120)}`);
  }
}

export function renderScorecard(card: Scorecard, judgeNote?: string): void {
  flushSuppressed();
  const W = 66;
  const line = dim("─".repeat(W));
  const pct = card.total
    ? Math.round((card.passed / Math.max(1, card.total - card.blocked)) * 100)
    : 0;

  console.log("");
  console.log(bold(cyan(`╭${"─".repeat(W - 2)}╮`)));
  console.log(
    bold(cyan("│")) +
      bold("  STARFIRE EVAL — FINAL SCORECARD".padEnd(W - 2)) +
      bold(cyan("│")),
  );
  console.log(bold(cyan(`╰${"─".repeat(W - 2)}╯`)));
  console.log(
    dim(`  run ${card.runId} @ ${card.gitCommit} · ${card.timestamp}`),
  );
  console.log(
    dim(
      `  model ${card.model} · ${card.provider} · dataset ${card.datasetVersion}`,
    ),
  );
  console.log("");
  console.log(`  ${bar(pct)}  ${bold(`${pct}%`)} of executed`);
  console.log(
    `  ${green(`✅ ${card.passed} passed`)}   ${red(`❌ ${card.failed} failed`)}   ${blue(`⛔ ${card.blocked} blocked`)}   ${dim(`total ${card.total}`)}`,
  );
  console.log(
    `  ${red(`P0 ${card.severities.P0}`)} · ${red(`P1 ${card.severities.P1}`)} · ${yellow(`P2 ${card.severities.P2}`)} · ${dim(`P3 ${card.severities.P3}`)}`,
  );

  if (Object.keys(card.categories).length) {
    console.log("");
    console.log(bold("  CATEGORY SCORES"));
    for (const [k, v] of Object.entries(card.categories)) {
      const s = v.score;
      const colored =
        s == null
          ? dim("n/a")
          : s >= 90
            ? green(`${s}%`)
            : s >= 70
              ? yellow(`${s}%`)
              : red(`${s}%`);
      console.log(
        `  ${(k ?? "").padEnd(14)} ${bar(s ?? 0, 20)}  ${colored} ${dim(`(${v.n})`)}`,
      );
    }
  }

  if (Object.keys(card.metrics).length) {
    console.log("");
    console.log(bold("  METRICS"));
    for (const [k, v] of Object.entries(card.metrics)) {
      console.log(
        `  ${k.padEnd(30)} ${v.score == null ? dim("n/a") : `${v.score}%`} ${dim(`(${v.n})`)}`,
      );
    }
  }

  const L = card.latency;
  console.log("");
  console.log(
    bold("  LATENCY (ms)") + dim("   (real, measured — never simulated)"),
  );
  console.log(
    dim(
      `  min ${Math.round(L.min)} · mean ${Math.round(L.mean)} · p50 ${Math.round(L.p50)} · p75 ${Math.round(L.p75)} · p90 ${Math.round(L.p90)} · p95 ${Math.round(L.p95)} · p99 ${Math.round(L.p99)} · max ${Math.round(L.max)}`,
    ),
  );
  console.log(
    bold("  USAGE") +
      `  in=${card.usage.input} out=${card.usage.output} total=${card.usage.total}`,
  );
  console.log(`  COST  ${card.usage.cost}`);
  if (judgeNote) console.log(`  ${dim("DEEPEVAL")}  ${judgeNote}`);

  if (card.findings.length) {
    console.log("");
    console.log(bold("  FINDINGS"));
    for (const f of card.findings) {
      const tag =
        f.level === "P0"
          ? red(bold(` ${f.level} `))
          : f.level === "P1"
            ? red(` ${f.level} `)
            : yellow(` ${f.level} `);
      console.log(
        `  ${tag} ${f.text.slice(0, 100)}${f.caseId ? dim(` (${f.caseId})`) : ""}`,
      );
    }
  }

  if (card.regression) {
    console.log("");
    console.log(bold(`  REGRESSION vs ${card.regression.baselineRunId}`));
    for (const x of card.regression.improved)
      console.log(`  ${green("GREEN")} ${x}`);
    for (const x of card.regression.regressed)
      console.log(`  ${red("RED  ")} ${x}`);
    for (const x of card.regression.redRegressions)
      console.log(`  ${red(bold("🚨   "))} ${x}`);
    if (card.regression.newlyFailing.length)
      console.log(
        `  ${dim("newly failing:")} ${card.regression.newlyFailing.join(", ")}`,
      );
    if (card.regression.newlyPassing.length)
      console.log(
        `  ${dim("newly passing:")} ${card.regression.newlyPassing.join(", ")}`,
      );
  }

  if (card.slowest.length)
    console.log(
      `\n  ${dim("SLOWEST")}      ${card.slowest.map((s) => `${s.caseId} ${s.ms}ms`).join(" · ")}`,
    );
  if (card.mostFailed.length)
    console.log(
      `  ${dim("MOST FAILED")}  ${card.mostFailed.map((s) => `${s.caseId}×${s.n}`).join(" · ")}`,
    );
  if (card.flaky.length)
    console.log(
      `  ${yellow("FLAKY")}        ${card.flaky.map((f) => `${f.caseId} (${Math.round(f.passRate * 100)}%)`).join(" · ")}`,
    );
  if (card.topRootCauses.length)
    console.log(
      `  ${dim("ROOT CAUSES")}   ${card.topRootCauses.map((x) => `${x.cause}:${x.n}`).join(" · ")}`,
    );
  console.log(line);
  console.log(dim(`  dashboard: eval/reports/latest.html`));
}

function kv(k: string, v: string): string {
  return `  ${dim(k.padEnd(14))} ${v}`;
}

export function renderCaseDetail(r: CaseResult): void {
  const line = dim("─".repeat(66));
  console.log("");
  console.log(bold(cyan(`CASE ${r.caseId} — ${r.title}`)));
  console.log(line);
  const badge =
    r.status === "pass"
      ? green("PASS")
      : r.status === "fail"
        ? red("FAIL")
        : blue("BLOCKED");
  console.log(
    kv(
      "STATUS",
      `${badge}${r.severity ? `  · ${r.severity} · root cause ${r.rootCause}` : ""}`,
    ),
  );
  console.log(`\n  ${bold("TRANSCRIPT")}`);
  for (const t of r.transcript) {
    const who =
      t.role === "user"
        ? cyan("USER ".padEnd(7))
        : t.role === "tool"
          ? yellow("TOOL ".padEnd(7))
          : green("ASSIST".padEnd(7));
    console.log(`  ${who} ${t.content.slice(0, 110)}`);
  }
  console.log(`\n  ${bold("TOOL CALLS")}`);
  if (!r.toolCalls.length) console.log(dim("    (none)"));
  for (const t of r.toolCalls) {
    const ok =
      t.ok === true
        ? green("ok")
        : t.ok === false
          ? red("error")
          : dim("skipped");
    console.log(
      `  #${t.index} ${bold(t.tool)} ${ok}  args=${JSON.stringify(t.parsedArgs)}${t.error ? ` err=${t.error}` : ""}`,
    );
    if (t.summary) console.log(dim(`     ↳ "${t.summary}"`));
  }
  console.log(`\n  ${bold("FINAL RESPONSE")}`);
  console.log(`  "${r.finalResponse}"`);
  console.log(`\n  ${bold("STATE DIFF")}`);
  const diff = r.stateDiff as Record<
    string,
    { before: unknown; after: unknown }
  > | null;
  if (!diff || Object.keys(diff).length === 0)
    console.log(dim("    (no state change)"));
  else {
    for (const [k, v] of Object.entries(diff)) {
      console.log(
        `  ${k}: ${red(JSON.stringify(v.before))} → ${green(JSON.stringify(v.after))}`,
      );
    }
  }
  if (r.invariantViolations.length)
    console.log(
      `  ${red("INVARIANT VIOLATIONS:")} ${r.invariantViolations.join(" | ")}`,
    );
  console.log(`\n  ${bold("METRICS")}`);
  for (const g of r.grades) {
    console.log(
      `  ${g.passed ? green("✓") : red("✗")} ${g.metric}: ${g.score} ${dim(`[${g.source}]`)} ${dim(g.reason.slice(0, 90))}`,
    );
  }
  console.log(
    `\n  ${bold("PERFORMANCE")}  total ${(r.durationMs / 1000).toFixed(2)}s · model ${Math.round(r.latency.modelMs)}ms · tools ${Math.round(r.latency.toolMs)}ms · iters ${r.latency.llmIterations}`,
  );
  console.log(
    kv(
      "TOKENS",
      `in=${r.tokens.input ?? "unknown"} out=${r.tokens.output ?? "unknown"}`,
    ),
  );
  console.log(
    kv("COST", r.costUsd != null ? `$${r.costUsd.toFixed(5)}` : "unknown"),
  );
  console.log(`\n  ${bold("DIAGNOSIS")}  ${r.explanation}`);
  console.log(line);
}
