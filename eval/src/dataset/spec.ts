import {
  type Category,
  type EvalCase,
  EvalCaseSchema,
  type ExpectedCallT,
  type InjectionT,
  type Severity,
  type StateExpectT,
  type TurnT,
} from "../types.js";

/** Flat authoring format: every field optional except id/title/category/turns. */
export type CaseSpec = {
  id: string;
  title: string;
  category: Category;
  turns: TurnT[];
  tags?: string[];
  calls?: ExpectedCallT[];
  alternatives?: ExpectedCallT[][];
  forbidden?: string[];
  allowedTools?: string[];
  minCalls?: number;
  maxCalls?: number;
  noDuplicateCalls?: boolean;
  state?: StateExpectT[];
  mustContainAny?: string[];
  mustNotContain?: string[];
  clarificationOk?: boolean;
  initialState?: Record<string, unknown>;
  clipboardSeed?: string;
  injectedContent?: string;
  secrets?: string[];
  injections?: InjectionT[];
  severity?: Severity;
  important?: boolean;
};

/** Build a fully-defaulted, schema-validated EvalCase from a flat spec. */
export function S(spec: CaseSpec): EvalCase {
  return EvalCaseSchema.parse({
    id: spec.id,
    title: spec.title,
    category: spec.category,
    turns: spec.turns,
    tags: spec.tags ?? [],
    expected: {
      calls: spec.calls ?? [],
      alternatives: spec.alternatives ?? [],
      forbidden: spec.forbidden ?? [],
      allowedTools: spec.allowedTools,
      minCalls: spec.minCalls ?? 0,
      maxCalls: spec.maxCalls,
      noDuplicateCalls: spec.noDuplicateCalls ?? false,
      state: spec.state ?? [],
      response: {
        mustContainAny: spec.mustContainAny ?? [],
        mustNotContain: spec.mustNotContain ?? [],
        clarificationOk: spec.clarificationOk ?? false,
      },
    },
    setup: {
      initialState: spec.initialState,
      clipboardSeed: spec.clipboardSeed,
      injectedContent: spec.injectedContent,
      secrets: spec.secrets ?? [],
      injections: spec.injections ?? [],
    },
    severity: spec.severity ?? "P2",
    important: spec.important ?? false,
  });
}

/** User turn helper. */
export const U = (content: string, lang?: "en" | "hi" | "hinglish"): TurnT =>
  lang ? { role: "user", content, lang } : { role: "user", content };

/** Convenience: one running app in the initial mock state. */
export const RUNNING = (name: string): Record<string, unknown> => ({
  [name.toLowerCase()]: { state: "running", window: "normal", focused: true },
});

/** Convenience call builders. */
export const call = (
  tool: string,
  args?: Record<string, unknown>,
  match: ExpectedCallT["match"] = "normalized",
): ExpectedCallT => ({ tool, args, match });
export const anyCall = (tool: string): ExpectedCallT => ({
  tool,
  match: "any",
});
export const state = (path: string, to: unknown): StateExpectT => ({
  path,
  op: "to",
  to,
});
export const stateIs = (path: string, value: unknown): StateExpectT => ({
  path,
  op: "equals",
  value,
});
export const inj = (
  port: string,
  kind: InjectionT["kind"],
  opts: { nth?: number; message?: string } = {},
): InjectionT => ({ port, kind, nth: opts.nth ?? 1, message: opts.message });
