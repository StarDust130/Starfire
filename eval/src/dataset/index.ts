import { type EvalCase, EvalCaseSchema } from "../types.js";
import { expandMultiTurn, expandToolMatrix } from "./matrices.js";
import {
  AMBIGUITY,
  ARGS,
  ARGS_STRESS,
  FAILURES,
  INJECTION,
  LEAKAGE,
  LOOP,
  MULTITOOL,
  MULTITURN,
  NO_TOOL_EXTRA,
  QUALITY,
  SAFETY,
  SESSION,
  TRAPS,
} from "./seeds.js";

function renumber(cases: EvalCase[]): EvalCase[] {
  const seen = new Set<string>();
  const out: EvalCase[] = [];
  let i = 1;
  for (const c of cases) {
    const parsed = EvalCaseSchema.safeParse(c);
    if (!parsed.success) {
      console.error(
        `DATASET SCHEMA ERROR in "${c.title}": ${parsed.error.issues.map((x) => x.message).join("; ")}`,
      );
      process.exitCode = 2;
      continue;
    }
    const fixed: EvalCase = {
      ...parsed.data,
      id: `C${String(i).padStart(3, "0")}`,
    };
    if (seen.has(fixed.title)) continue;
    seen.add(fixed.title);
    out.push(fixed);
    i += 1;
  }
  return out;
}

export function buildDataset(): EvalCase[] {
  return renumber([
    ...expandToolMatrix(),
    ...TRAPS,
    ...NO_TOOL_EXTRA,
    ...ARGS,
    ...ARGS_STRESS,
    ...expandMultiTurn(),
    ...MULTITURN,
    ...AMBIGUITY,
    ...FAILURES,
    ...LOOP,
    ...SAFETY,
    ...INJECTION,
    ...LEAKAGE,
    ...SESSION,
    ...MULTITOOL,
    ...QUALITY,
  ]);
}
