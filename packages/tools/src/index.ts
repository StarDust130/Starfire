export { createDefaultRegistry } from "./defaults.js";
export { type ToolPolicy, type ToolRisk, toolPolicies } from "./policy.js";
export {
  type FunctionTool,
  type ToolDefinition,
  type ToolHandler,
  ToolRegistry,
  type ToolRegistryOptions,
} from "./registry.js";
export { ToolError } from "./tool-error.js";
export type { WeatherAdapter } from "./tools/get-weather.js";

export { createDefaultTools } from "./tools/index.js";
export type { WebSearchAdapter } from "./tools/web-search.js";
export type { WindowControlAdapter } from "./tools/window-control.js";
export {
  type ValidatedArgs,
  type ValidationResult,
  validateToolArgs,
} from "./validate.js";
