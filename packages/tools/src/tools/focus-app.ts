import type { AgentPorts, ToolManifest } from "@starfire/contracts";

import type { ToolDefinition } from "../registry.js";

export function createFocusAppTool(ports: AgentPorts): ToolDefinition {
  const manifest: ToolManifest = {
    name: "focus_app",

    description:
      "Bring an application window to the front. May not be supported " +
      "on every Linux desktop (Wayland restricts window focus).",

    danger: "safe",

    parameters: {
      type: "object",

      properties: {
        app: {
          type: "string",

          description: "Name of the application to focus.",
        },
      },

      required: ["app"],
    },
  };

  return {
    manifest,

    async handle(args) {
      const app = args.app as string;

      const outcome = await ports.apps.focus(app);

      if (!outcome.focused) {
        return {
          summary: outcome.detail ?? `I couldn't bring ${app} to the front.`,

          data: { app, focused: false },
        };
      }

      return {
        summary: `Brought ${app} to the front.`,

        data: { app, focused: true },
      };
    },
  };
}
