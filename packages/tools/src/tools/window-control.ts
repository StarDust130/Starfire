import type { ToolManifest, WindowAction } from "@starfire/contracts";
import type { ToolDefinition } from "../registry.js";
import { ToolError } from "../tool-error.js";

export type WindowControlAdapter = {
  control(
    action: WindowAction,
    app?: string,
  ): Promise<{
    done: boolean;

    detail?: string;
  }>;
};

/*
 * Synonyms the model (or the user) may naturally use. They are in
 * the manifest enum so the model picks valid values, and mapped to
 * the canonical action before the port is called.
 */
const SYNONYMS: Record<string, WindowAction> = {
  focus: "focus",
  raise: "focus",
  front: "focus",
  "bring-to-front": "focus",
  "bring-to-the-front": "focus",
  activate: "focus",

  lower: "lower",
  back: "lower",
  "send-to-back": "lower",
  "send-behind": "lower",

  minimize: "minimize",

  maximize: "maximize",

  restore: "restore",
  unminimize: "restore",
};

export function createWindowControlTool(
  adapter: WindowControlAdapter,
): ToolDefinition {
  const manifest: ToolManifest = {
    name: "window_control",

    description:
      "Perform a basic window action on the user's desktop: focus " +
      "(bring to front), lower (send behind), minimize, maximize, or " +
      "restore. Works on KDE. Use for window actions; open_app and " +
      "close_app launch or quit apps instead.",

    danger: "safe",

    parameters: {
      type: "object",

      properties: {
        action: {
          type: "string",

          description:
            "The window action to perform (synonyms like 'raise' or " +
            "'unminimize' are accepted and mapped automatically).",

          enum: Object.keys(SYNONYMS),
        },

        app: {
          type: "string",

          description:
            "Optional target application name. Omit to act on the active window.",
        },
      },

      required: ["action"],
    },
  };

  return {
    manifest,

    async handle(args) {
      const rawAction = args.action as string;

      const action = SYNONYMS[rawAction];

      if (!action) {
        throw new ToolError(
          `"${rawAction}" is not a window action I know. Try focus, lower, minimize, maximize, or restore.`,
        );
      }

      const app = typeof args.app === "string" ? args.app : undefined;

      const outcome = await adapter.control(action, app);

      if (!outcome.done) {
        throw new ToolError(
          outcome.detail ?? "That window action didn't work right now.",
        );
      }

      const said: Record<WindowAction, string> = {
        focus: "Brought it to the front.",

        lower: "Sent it behind the other windows.",

        minimize: "Minimized.",

        maximize: "Maximized.",

        restore: "Restored.",
      };

      return {
        summary: said[action],

        data: { action, app: app ?? null },
      };
    },
  };
}
