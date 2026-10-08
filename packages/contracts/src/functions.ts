/**
 * Model-facing function specs for Starfire's platform capabilities,
 * in the JSON-schema form realtime models require in `session.update`.
 *
 * DERIVED from the canonical capability definitions in
 * `capabilities.ts` — do not add tool definitions here. Consumers:
 * the Electron realtime voice bridge and the eval driver.
 *
 * This is data, not a registry: Eve owns tool discovery, validation,
 * and execution for the agent path.
 */

import { STARFIRE_CAPABILITIES } from "./capabilities.js";

export type StarfireFunctionSpec = {
  type: "function";
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<
      string,
      { type: string; description?: string; enum?: string[] }
    >;
    required: string[];
  };
};

export const STARFIRE_FUNCTION_SPECS: StarfireFunctionSpec[] =
  STARFIRE_CAPABILITIES.map((capability) => ({
    type: "function",
    name: capability.name,
    description: capability.description,
    parameters: {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(capability.parameters.properties).map(
          ([key, property]) => [key, { ...property }],
        ),
      ),
      required: [...capability.parameters.required],
    },
  }));

export const STARFIRE_TOOL_NAMES = STARFIRE_FUNCTION_SPECS.map(
  (spec) => spec.name,
);
