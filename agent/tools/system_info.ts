import { defineTool } from "eve/tools";
import { z } from "zod";

import { desktop } from "../lib/desktop.js";

export default defineTool({
  description:
    "Check system status such as RAM, CPU, uptime, disk, " +
    "battery, or host information.",

  inputSchema: z.object({
    query: z.enum(["memory", "cpu", "uptime", "disk", "battery", "host"]),
  }),

  async execute({ query }) {
    const result = await desktop.system.info(query);

    return {
      summary: result.summary,
      data: result.data ?? null,
    };
  },
});
