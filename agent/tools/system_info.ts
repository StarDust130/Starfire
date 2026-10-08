import { defineTool } from "eve/tools";

import { getStarfireCapability } from "../../packages/contracts/src/capabilities.js";

import { desktop } from "../lib/desktop.js";

const capability = getStarfireCapability("system_info");

export default defineTool({
  description: capability.description,

  inputSchema: capability.parameters,

  async execute(input: {
    query: "memory" | "cpu" | "uptime" | "disk" | "battery" | "host";
  }) {
    const result = await desktop.system.info(input.query);

    return {
      summary: result.summary,
      data: result.data ?? null,
    };
  },
});
