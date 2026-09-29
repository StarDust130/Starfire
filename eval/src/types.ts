export type CaseCategory =
  | "tool"
  | "conversation"
  | "multi-turn"
  | "invalid"
  | "failure"
  | "edge"
  | "voice";

export type CaseInput = {
  utterances: string[];

  category: CaseCategory;

  expect?: {
    tools?: string[];

    notTools?: string[];

    summaryContains?: string[];

    summaryNotContains?: string[];

    micRms?: number;
  };

  latencyBudgetMs?: number;
};

export type CaseStep = {
  toolCalls: Array<{ name: string; args: unknown }>;

  summary: string;

  ok: boolean;

  error?: string;

  durationMs: number;
};

export type CaseResult = {
  id: string;

  title: string;

  category: CaseCategory;

  passed: boolean;

  reasons: string[];

  durationMs: number;

  steps: CaseStep[];

  tokens: { input: number; output: number };

  score: {
    toolSelection: boolean;

    taskSuccess: boolean;

    responseQuality: boolean;

    reliable: boolean;

    withinLatency: boolean;
  };
};

export type EvalScores = {
  cases: number;

  passed: number;

  failed: number;

  successPct: number;

  toolSelectionPct: number;

  taskSuccessPct: number;

  qualityPct: number;

  reliabilityPct: number;

  latencyP50: number;

  latencyP95: number;

  latencyBudgetViolations: number;

  tokens: { input: number; output: number };

  costUsd: number;

  failures: Array<{ id: string; title: string; reasons: string[] }>;

  slowest: Array<{ id: string; title: string; durationMs: number }>;
};
