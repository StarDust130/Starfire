/**
 * Single seam between eval and Starfire.
 * ALL imports are relative to SOURCE files — no package-name resolution,
 * no dist/, no exports-map, no stale-build class of bugs. Ever.
 *
 * Eve owns the agent runtime and tool validation. Evals exercise the
 * remaining Starfire behavior: the canonical capability definitions and
 * the shared capability dispatch (the same boundary Eve tools call over
 * HTTP and the voice bridge calls in-process).
 */

export * from "../../packages/contracts/src/index.js";

import { STARFIRE_FUNCTION_SPECS } from "../../packages/contracts/src/functions.js";

export { ToolError } from "../../apps/desktop/electron/agent/tool-error.js";

import { executeDeviceTool } from "../../packages/contracts/src/dispatch.js";

export { executeDeviceTool };

export type ToolCallOutcome = {
  ok: boolean;

  result?: unknown;

  error?: string;
};

/**
 * Behavior-level arg check against the platform function specs.
 *
 * Eve + zod validate arguments on the real agent path; this mirror
 * exists only so eval grading can tell "bad args" apart from other
 * tool failures without resurrecting the old validation system.
 */
export function checkToolArgs(
  tool: string,
  args: Record<string, unknown> | null,
): { ok: boolean; errors: string[] } {
  const spec = STARFIRE_FUNCTION_SPECS.find((s) => s.name === tool);

  if (!spec) {
    return { ok: false, errors: [`unknown tool "${tool}"`] };
  }

  const errors: string[] = [];

  const value = args ?? {};

  for (const key of spec.parameters.required) {
    if (
      value[key] === undefined ||
      value[key] === null ||
      (typeof value[key] === "string" && value[key].trim().length === 0)
    ) {
      errors.push(`missing "${key}"`);
    }
  }

  for (const [key, def] of Object.entries(spec.parameters.properties)) {
    const v = value[key];

    if (v === undefined || v === null) continue;

    if (def.enum && typeof v === "string" && !def.enum.includes(v)) {
      errors.push(`"${key}" must be one of [${def.enum.join(", ")}]`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Execute one device tool call with the eval timeout applied, mapping
 * every outcome to a plain {ok, result?, error?} shape.
 */
export async function runDeviceTool(
  ports: AgentPorts,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs = 2000,
): Promise<ToolCallOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const result = await Promise.race([
      executeDeviceTool(ports, tool, args),

      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ToolError("The action took too long.")),
          timeoutMs,
        );
      }),
    ]);

    return { ok: true, result };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Tool execution failed.",
    };
  } finally {
    clearTimeout(timer);
  }
}
