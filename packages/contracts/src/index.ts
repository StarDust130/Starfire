/**
 * Shared contracts. agent.ts is the SINGLE SOURCE OF TRUTH for the
 * tool system (manifests, calls, results, OS ports). The older
 * inline ToolRequest/ToolResult scaffold that lived here is retired —
 * its replacement lives in agent.ts.
 */
export * from "./agent.js";
