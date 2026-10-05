import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaseResult } from "./types.js";

export type JudgeOutcome = {
  available: boolean;
  reason?: string;
  results: Record<
    string,
    Record<string, { score: number | null; reason: string; status: string }>
  >;
};

function run(
  cmd: string,
  args: string[],
  input?: string,
  timeoutMs = 900_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env: process.env });
    let out = "";
    let err = "";
    const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ code: code ?? 1, stdout: out, stderr: err });
    });
    if (input) p.stdin.write(input);
    p.stdin.end();
  });
}

const NO_JUDGE_REASON =
  "LLM-judge metrics BLOCKED — the agent model (qwen3-8-omni-flash-realtime) is a realtime WebSocket S2S model with no chat-completion interface DeepEval can call, and no judge endpoint was explicitly configured. " +
  "We never silently fall back to another provider. To enable judging, set STARFIRE_EVAL_JUDGE_BASE_URL, STARFIRE_EVAL_JUDGE_API_KEY and STARFIRE_EVAL_JUDGE_MODEL to an OpenAI-compatible chat endpoint. Deterministic metrics are unaffected.";

export async function runJudge(
  results: CaseResult[],
  pyBin: string,
): Promise<JudgeOutcome> {
  const check = await run(pyBin, ["-c", "import deepeval"]);
  if (check.code !== 0) {
    return {
      available: false,
      reason: `python package 'deepeval' not importable via ${pyBin} — judge metrics BLOCKED (deterministic scores unaffected). Install: pip install deepeval`,
      results: {},
    };
  }

  // Judge LLM: ONLY an explicitly configured endpoint. Never the S2S agent model
  // (no chat interface), never a silent OpenAI fallback.
  const baseUrl = process.env.STARFIRE_EVAL_JUDGE_BASE_URL;
  const apiKey = process.env.STARFIRE_EVAL_JUDGE_API_KEY;
  const model = process.env.STARFIRE_EVAL_JUDGE_MODEL;
  if (!baseUrl || !apiKey || !model) {
    return { available: false, reason: NO_JUDGE_REASON, results: {} };
  }

  const items = results
    .filter((r) => r.status !== "blocked")
    .map((r) => ({
      caseId: r.caseId,
      category: r.category,
      input: r.transcript
        .filter((t) => t.role === "user")
        .map((t) => t.content)
        .join("\n"),
      actualOutput: r.finalResponse,
      toolsExpected: r.toolCalls.map((t) => t.tool),
    }));
  if (items.length === 0) return { available: true, results: {} };

  const inFile = join(tmpdir(), `starfire-eval-in-${Date.now()}.json`);
  const outFile = join(tmpdir(), `starfire-eval-out-${Date.now()}.json`);
  writeFileSync(
    inFile,
    JSON.stringify({ items, judge: { baseUrl, apiKey, model } }),
  );
  const proc = await run(pyBin, [
    join(import.meta.dirname ?? ".", "..", "python", "deepeval_bridge.py"),
    inFile,
    outFile,
  ]);
  if (proc.code !== 0)
    return {
      available: false,
      reason: `bridge failed: ${proc.stderr.slice(0, 500)}`,
      results: {},
    };
  if (!existsSync(outFile))
    return {
      available: false,
      reason: "bridge produced no output",
      results: {},
    };
  const parsed = JSON.parse(readFileSync(outFile, "utf8")) as {
    results: JudgeOutcome["results"];
  };
  return { available: true, results: parsed.results ?? {} };
}
