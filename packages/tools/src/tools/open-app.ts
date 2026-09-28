import type { AgentPorts, ToolManifest } from "@starfire/contracts";

import type { ToolDefinition } from "../registry.js";

export function createOpenAppTool(ports: AgentPorts): ToolDefinition {
  const manifest: ToolManifest = {
    name: "open_app",

    description:
      "Launch a desktop application. Use for requests like 'open VS Code', " +
      "start Discord, launch the calculator. Pass the app name the user said.",

    danger: "safe",

    parameters: {
      type: "object",

      properties: {
        app: {
          type: "string",

          description:
            "Name of the application to open, e.g. 'vs code', 'discord', 'firefox'.",
        },
      },

      required: ["app"],
    },
  };

  return {
    manifest,

    async handle(args) {
      const app = args.app as string;

      const opened = await ports.apps.open(app);

      return {
        summary: `Opening ${opened.name}.`,

        data: { app: opened.name, pid: opened.pid },
      };
    },
  };
}
