import { defineTool } from "eve/tools";
import { z } from "zod";

import { desktop } from "../lib/desktop.js";

export default defineTool({
  description:
    "Search the web for current information, news, prices, " +
    "releases, facts, and other information that may have changed.",

  inputSchema: z.object({
    query: z.string().min(1),
  }),

  async execute({ query }) {
    const result = await desktop.web.search(query);

    if (result.results.length === 0 && result.answer.length === 0) {
      throw new Error(`I found nothing for "${query}".`);
    }

    return {
      answer: result.answer,
      results: result.results.slice(0, 5),
    };
  },
});
