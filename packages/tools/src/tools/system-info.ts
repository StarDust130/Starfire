import type {
  AgentPorts,
  SystemInfoQuery,
  ToolManifest,
} from "@starfire/contracts";

import type { ToolDefinition } from "../registry.js";

export function createSystemInfoTool(ports: AgentPorts): ToolDefinition {
  const manifest: ToolManifest = {
    name: "system_info",

    description:
      "Check system status: memory/RAM usage, cpu load, uptime, disk " +
      "usage, battery, or host info. Use for 'how much RAM am I using?'.",

    danger: "safe",

    parameters: {
      type: "object",

      properties: {
        query: {
          type: "string",

          description: "Which system information to report.",

          enum: ["memory", "cpu", "uptime", "disk", "battery", "host"],
        },
      },

      required: ["query"],
    },
  };

  return {
    manifest,

    async handle(args) {
      const query = args.query as SystemInfoQuery;

      const info = await ports.system.info(query);

      return {
        summary: info.summary,

        data: info.data,
      };
    },
  };
}
