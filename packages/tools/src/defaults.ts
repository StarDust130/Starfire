import type { AgentPorts } from "@starfire/contracts";
import { ToolRegistry, type ToolRegistryOptions } from "./registry.js";
import { createDefaultTools } from "./tools/index.js";

/**
 * The registry the Electron voice glue will use: every V0 tool
 * registered against real ports.
 */
export function createDefaultRegistry(
  ports: AgentPorts,
  options: ToolRegistryOptions = {},
): ToolRegistry {
  const registry = new ToolRegistry(options);

  registry.registerAll(createDefaultTools(ports));

  return registry;
}
