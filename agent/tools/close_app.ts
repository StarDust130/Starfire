import { defineTool } from "eve/tools";

import { getStarfireCapability } from "../../packages/contracts/src/capabilities.js";

import { desktop } from "../lib/desktop.js";

const capability = getStarfireCapability("close_app");

export default defineTool({
  description: capability.description,

  inputSchema: capability.parameters,

  async execute(input: { app: string }) {
    const { app } = input;

    const result = await desktop.apps.close(app);

    if (!result.closed) {
      throw new Error(
        result.detail ?? `I couldn't find ${app} running right now.`,
      );
    }

    return {
      summary: `Closing ${app}.`,
      app,
      via: result.via,
    };
  },
});
