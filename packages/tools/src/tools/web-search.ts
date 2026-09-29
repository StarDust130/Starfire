import type { ToolManifest } from "@starfire/contracts";
import type { ToolDefinition } from "../registry.js";
import { ToolError } from "../tool-error.js";

export type WebSearchAdapter = {
  search(query: string): Promise<{
    answer: string;

    results: Array<{ title: string; url: string; snippet: string }>;
  }>;
};

/**
 * The manifest lives with the tool; the EXA HTTP call lives behind
 * the adapter (implemented in electron with the key). Tools never
 * see secrets.
 */
export function createWebSearchTool(adapter: WebSearchAdapter): ToolDefinition {
  const manifest: ToolManifest = {
    name: "web_search",

    description:
      "Search the web for current information: news, facts, prices, " +
      "releases, anything you don't already know. Use for questions " +
      "about recent or real-world events.",

    danger: "safe",

    parameters: {
      type: "object",

      properties: {
        query: {
          type: "string",

          description:
            "The web search query, phrased like a search engine query.",
        },
      },

      required: ["query"],
    },
  };

  return {
    manifest,

    async handle(args) {
      const query = args.query as string;

      const result = await adapter.search(query);

      if (result.results.length === 0 && result.answer.length === 0) {
        throw new ToolError(`I found nothing for "${query}".`);
      }

      return {
        summary: result.answer,

        data: {
          results: result.results.slice(0, 5),
        },
      };
    },
  };
}
