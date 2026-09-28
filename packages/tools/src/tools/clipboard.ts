import type { AgentPorts, ToolManifest } from "@starfire/contracts";
import type { ToolDefinition } from "../registry.js";
import { ToolError } from "../tool-error.js";

const PREVIEW_LIMIT = 160;

export function createClipboardTool(ports: AgentPorts): ToolDefinition {
  const manifest: ToolManifest = {
    name: "clipboard",

    description:
      "Read from or write to the system clipboard. Use action 'read' " +
      "for 'what did I copy?', action 'write' with text to copy " +
      "something for the user.",

    danger: "safe",

    parameters: {
      type: "object",

      properties: {
        action: {
          type: "string",

          description: "Whether to read the clipboard or write to it.",

          enum: ["read", "write"],
        },

        text: {
          type: "string",

          description:
            "The text to put on the clipboard (required when action is 'write').",
        },
      },

      required: ["action"],
    },
  };

  return {
    manifest,

    async handle(args) {
      const action = args.action as "read" | "write";

      if (action === "write") {
        const text = args.text;

        if (typeof text !== "string" || text.trim().length === 0) {
          throw new ToolError("What should I copy? Tell me the text first.");
        }

        await ports.clipboard.write(text);

        return {
          summary: "Copied that to your clipboard.",

          data: { length: text.length },
        };
      }

      const text = await ports.clipboard.read();

      if (text.trim().length === 0) {
        return {
          summary: "Your clipboard is empty.",

          data: { empty: true },
        };
      }

      const preview =
        text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}…` : text;

      return {
        summary: `Your clipboard says: "${preview}"`,

        data: { length: text.length },
      };
    },
  };
}
