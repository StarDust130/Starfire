import { defineTool } from "eve/tools";
import { z } from "zod";

import { desktop } from "../lib/desktop.js";

const URL_PATTERN = /^https?:\/\/\S+$/i;

export default defineTool({
  description: "Open a website in the user's browser. Pass a full URL.",

  inputSchema: z.object({
    url: z.string().min(1),
  }),

  async execute({ url }) {
    const trimmed = url.trim();

    if (!URL_PATTERN.test(trimmed)) {
      throw new Error(`"${url}" is not a valid website URL. Use https://...`);
    }

    const result = await desktop.urls.open(trimmed);

    return {
      summary: `Opening ${result.opened}.`,
      url: trimmed,
    };
  },
});
