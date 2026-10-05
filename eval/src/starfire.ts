/**
 * Single seam between eval and Starfire.
 * ALL imports are relative to SOURCE files — no package-name resolution,
 * no dist/, no exports-map, no stale-build class of bugs. Ever.
 */

export {
  AgentRunner,
  type AgentRunnerOptions,
  type AgentTurnEvent,
  type ToolExecutor,
} from "../../apps/core/src/agent/agent-runner.js";
export * from "../../packages/contracts/src/agent.js";
export { createDefaultRegistry } from "../../packages/tools/src/defaults.js";
export {
  type ToolPolicy,
  type ToolRisk,
  toolPolicies,
} from "../../packages/tools/src/policy.js";
export {
  type FunctionTool,
  type ToolDefinition,
  type ToolHandler,
  ToolRegistry,
  type ToolRegistryOptions,
} from "../../packages/tools/src/registry.js";
export { ToolError } from "../../packages/tools/src/tool-error.js";
export {
  type ValidatedArgs,
  type ValidationResult,
  validateToolArgs,
} from "../../packages/tools/src/validate.js";
