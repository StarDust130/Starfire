import type { AgentPorts, ToolManifest } from "@starfire/contracts";

import type { ToolDefinition } from "../registry.js";

export function createOpenFileTool(ports: AgentPorts): ToolDefinition {
  const manifest: ToolManifest = {
    name: "open_file",

    description:
      "Open a file with its default application. Use for 'open " +
      "README.md'. Pass a file name or an absolute path.",

    danger: "safe",

    parameters: {
      type: "object",

      properties: {
        path: {
          type: "string",

          description: "File name or absolute path to open.",
        },
      },

      required: ["path"],
    },
  };

  return {
    manifest,

    async handle(args) {
      const path = args.path as string;

      const opened = await ports.files.openFile(path);

      return {
        summary: `Opening ${opened.opened}.`,

        data: { path: opened.opened },
      };
    },
  };
}
