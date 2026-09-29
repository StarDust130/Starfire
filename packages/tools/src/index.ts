export { createDefaultRegistry } from "./defaults.js";
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
/**
 * Adapter contracts implemented by Electron main (or faked in
 * tests). Exported so the desktop side can build against the same
 * shapes the tools consume.
 */
export type { WebSearchAdapter } from "./tools/web-search.js";
export type { WindowControlAdapter } from "./tools/window-control.js";
export {
  type ValidatedArgs,
  type ValidationResult,
  validateToolArgs,
} from "./validate.js";
