import type { ToolManifest } from "@starfire/contracts";
import type { ToolDefinition } from "../registry.js";
import { ToolError } from "../tool-error.js";

export type UrlAdapter = {
  open(url: string): Promise<{ opened: string }>;
};

const URL_PATTERN = /^https?:\/\/\S+$/i;

export function createOpenUrlTool(adapter: UrlAdapter): ToolDefinition {
  const manifest: ToolManifest = {
    name: "open_url",

    description:
      "Open a website in the user's browser. Use for 'open YouTube', " +
      "'open google.com', or any https link. Pass the full URL.",

    danger: "safe",

    parameters: {
      type: "object",

      properties: {
        url: {
          type: "string",

          description:
            "Full https URL to open, e.g. 'https://www.youtube.com'.",
        },
      },

      required: ["url"],
    },
  };

  return {
    manifest,

    async handle(args) {
      const url = args.url as string;

      if (!URL_PATTERN.test(url.trim())) {
        throw new ToolError(
          `"${url}" is not a valid website link — it should start with https://`,
        );
      }

      const opened = await adapter.open(url.trim());

      return {
        summary: `Opening ${opened.opened}.`,

        data: { url: opened.opened },
      };
    },
  };
}
