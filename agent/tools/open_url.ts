import { defineTool } from "eve/tools";

import { getStarfireCapability } from "../../packages/contracts/src/capabilities.js";

import { desktop } from "../lib/desktop.js";

const capability = getStarfireCapability("open_url");

const URL_PATTERN = /^https?:\/\/\S+$/i;

export default defineTool({
  description: capability.description,

  inputSchema: capability.parameters,

  async execute(input: { url: string }) {
    const url = input.url.trim();

    if (!URL_PATTERN.test(url)) {
      throw new Error(`"${url}" is not a valid website URL. Use https://...`);
    }

    const result = await desktop.urls.open(url);

    return {
      summary: `Opening ${result.opened}.`,
      url,
    };
  },
});
