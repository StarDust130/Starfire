import { defineTool } from "eve/tools";

import { getStarfireCapability } from "../../packages/contracts/src/capabilities.js";

import { desktop } from "../lib/desktop.js";

const capability = getStarfireCapability("open_app");

export default defineTool({
  description: capability.description,

  inputSchema: capability.parameters,

  async execute(input: { app: string }) {
    const opened = await desktop.apps.open(input.app);

    return {
      summary: `Opening ${opened.name}.`,
      app: opened.name,
      pid: opened.pid ?? null,
    };
  },
});
