import type { WebSearchResultItem } from "@starfire/contracts";
import type { WebSearchAdapter } from "@starfire/tools";
import { ToolError } from "@starfire/tools";

const EXA_ENDPOINT = "https://api.exa.ai/search";

const REQUEST_TIMEOUT_MS = 8000;

const MAX_RESULTS = 5;

/*
 * Exa adapter for the web_search tool. Runs in the Electron main
 * process ONLY — the API key never crosses the preload bridge.
 *
 * (V0 uses a direct fetch. When you later add more providers via the
 * Vercel AI SDK, swap this file — tools/contracts/registry are
 * untouched.)
 */
export function createExaSearchAdapter(
  apiKey: string | undefined,
): WebSearchAdapter {
  return {
    async search(query: string) {
      if (!apiKey || apiKey.trim().length === 0) {
        throw new ToolError(
          "Web search isn't configured — I need an EXA_API_KEY to do that.",
        );
      }

      const controller = new AbortController();

      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch(EXA_ENDPOINT, {
          method: "POST",

          headers: {
            "x-api-key": apiKey,

            "content-type": "application/json",
          },

          body: JSON.stringify({
            query,

            numResults: MAX_RESULTS,

            contents: {
              text: { maxCharacters: 300 },
            },
          }),

          signal: controller.signal,
        });

        if (!response.ok) {
          throw new ToolError(
            response.status === 401 || response.status === 403
              ? "Web search rejected my API key — check EXA_API_KEY."
              : "The web search service didn't respond properly.",
          );
        }

        const payload = (await response.json()) as {
          results?: Array<{
            title?: string;

            url?: string;

            text?: string;
          }>;
        };

        const results: WebSearchResultItem[] = (payload.results ?? [])
          .filter((item) => typeof item.url === "string")
          .map((item) => ({
            title: item.title ?? item.url ?? "result",

            url: item.url ?? "",

            snippet: (item.text ?? "").replace(/\s+/g, " ").trim(),
          }));

        const answer =
          results.length > 0
            ? `I found ${results.length} result${results.length === 1 ? "" : "s"} for that.`
            : "";

        return { answer, results };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
