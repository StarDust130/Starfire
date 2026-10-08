import { defineTool } from "eve/tools";

import { getStarfireCapability } from "../../packages/contracts/src/capabilities.js";

import { desktop } from "../lib/desktop.js";

const capability = getStarfireCapability("web_search");

export default defineTool({
  description: capability.description,

  inputSchema: capability.parameters,

  async execute(input: { query: string }) {
    const result = await desktop.web.search(input.query);

    if (result.results.length === 0 && result.answer.length === 0) {
      throw new Error(`I found nothing for "${input.query}".`);
    }

    return {
      answer: result.answer,
      results: result.results.slice(0, 5),
    };
  },
});
