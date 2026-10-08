import { z } from "zod";

export const CATEGORIES = [
  "tool",
  "args",
  "no-tool",
  "multi-turn",
  "multi-tool",
  "ambiguity",
  "failure",
  "loop",
  "safety",
  "injection",
  "leakage",
  "session",
  "quality",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const SEVERITIES = ["P0", "P1", "P2", "P3"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const ExpectedCallSchema = z.object({
  tool: z.string(),
  args: z.record(z.string(), z.unknown()).optional(),
  match: z
    .enum(["exact", "normalized", "contains", "any"])
    .default("normalized"),
});
export type ExpectedCallT = z.infer<typeof ExpectedCallSchema>;

export const StateExpectSchema = z.object({
  path: z.string(),
  op: z.enum(["equals", "to", "changed"]),
  value: z.unknown().optional(),
  to: z.unknown().optional(),
});
export type StateExpectT = z.infer<typeof StateExpectSchema>;

export const TurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  lang: z.enum(["en", "hi", "hinglish"]).optional(),
});
export type TurnT = z.infer<typeof TurnSchema>;

export const InjectionSchema = z.object({
  port: z.string(),
  nth: z.number().int().min(1).default(1),
  kind: z.enum([
    "tool_error",
    "timeout",
    "internal",
    "empty",
    "malformed",
    "partial",
  ]),
  message: z.string().optional(),
});
export type InjectionT = z.infer<typeof InjectionSchema>;

const ResponseExpectSchema = z.object({
  mustContainAny: z.array(z.string()).default([]),
  mustNotContain: z.array(z.string()).default([]),
  clarificationOk: z.boolean().default(false),
});

export const EvalCaseSchema = z.object({
  id: z.string(),
  title: z.string(),
  category: z.enum(CATEGORIES),
  tags: z.array(z.string()).default([]),
  turns: z.array(TurnSchema).min(1),
  expected: z
    .object({
      calls: z.array(ExpectedCallSchema).default([]),
      alternatives: z.array(z.array(ExpectedCallSchema)).default([]),
      forbidden: z.array(z.string()).default([]),
      allowedTools: z.array(z.string()).optional(),
      minCalls: z.number().int().default(0),
      maxCalls: z.number().int().optional(),
      noDuplicateCalls: z.boolean().default(false),
      state: z.array(StateExpectSchema).default([]),
      response: ResponseExpectSchema.default({
        mustContainAny: [],
        mustNotContain: [],
        clarificationOk: false,
      }),
    })
    .prefault({}),
  setup: z
    .object({
      initialState: z.record(z.string(), z.unknown()).optional(),
      clipboardSeed: z.string().optional(),
      injectedContent: z.string().optional(),
      secrets: z.array(z.string()).default([]),
      injections: z.array(InjectionSchema).default([]),
    })
    .prefault({}),
  severity: z.enum(SEVERITIES).default("P2"),
  important: z.boolean().default(false),
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;

export type ToolCallRecord = {
  index: number;
  turn: number;
  tool: string;
  rawArgs: string | null;
  parsedArgs: unknown;
  validation: { ok: boolean; errors: string[] };
  executed: boolean;
  ok: boolean | null;
  summary: string | null;
  error: string | null;
  batchStateChanged: boolean;
};

export type CaseResult = {
  runId: string;
  caseId: string;
  title: string;
  category: Category;
  tags: string[];
  status: "pass" | "fail" | "blocked";
  blockedReason?: string;
  model: string;
  provider: string;
  durationMs: number;
  latency: {
    modelMs: number;
    toolMs: number;
    totalMs: number;
    llmIterations: number;
  };
  tokens: { input: number | null; output: number | null; total: number | null };
  costUsd: number | null;
  toolCalls: ToolCallRecord[];
  finalResponse: string;
  transcript: { role: string; content: string }[];
  stateBefore: unknown;
  stateAfter: unknown;
  stateDiff: Record<string, { before: unknown; after: unknown }> | null;
  invariantViolations: string[];
  grades: {
    metric: string;
    score: number | null;
    passed: boolean;
    reason: string;
    source: "deterministic" | "deepeval";
  }[];
  failureKinds: string[];
  severity: Severity | null;
  rootCause: string | null;
  explanation: string;
  trials?: { pass: boolean; score: number }[];
  passRate?: number;
  retries?: number;
};
