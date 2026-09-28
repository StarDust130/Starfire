import type { AgentPorts, ToolManifest } from "@starfire/contracts";

import type { ToolDefinition } from "../registry.js";

export function createOpenFolderTool(ports: AgentPorts): ToolDefinition {
  const manifest: ToolManifest = {
    name: "open_folder",

    description:
      "Open a folder in the system file manager. Use for 'open my " +
      "Projects folder'. Pass a folder name or an absolute path.",

    danger: "safe",

    parameters: {
      type: "object",

      properties: {
        path: {
          type: "string",

          description: "Folder name or absolute path to open.",
        },
      },

      required: ["path"],
    },
  };

  return {
    manifest,

    async handle(args) {
      const path = args.path as string;

      const opened = await ports.files.openFolder(path);

      return {
        summary: `Opening ${opened.opened}.`,

        data: { path: opened.opened },
      };
    },
  };
}
