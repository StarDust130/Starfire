import type { AgentPorts, ToolManifest } from "@starfire/contracts";
import type { ToolDefinition } from "../registry.js";
import { ToolError } from "../tool-error.js";

export function createCloseAppTool(ports: AgentPorts): ToolDefinition {
  const manifest: ToolManifest = {
    name: "close_app",

    description:
      "Close a running desktop application gracefully (like clicking X). " +
      "Use for 'close Discord', 'quit Firefox'. Apps with unsaved work " +
      "will ask the user themselves.",

    danger: "safe",

    parameters: {
      type: "object",

      properties: {
        app: {
          type: "string",

          description: "Name of the application to close.",
        },
      },

      required: ["app"],
    },
  };

  return {
    manifest,

    async handle(args) {
      const app = args.app as string;

      const outcome = await ports.apps.close(app);

      if (!outcome.closed) {
        throw new ToolError(
          outcome.detail ?? `I couldn't find ${app} running right now.`,
        );
      }

      return {
        summary: `Closing ${app}.`,

        data: { app, via: outcome.via },
      };
    },
  };
}
