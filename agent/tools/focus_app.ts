import { defineTool } from "eve/tools";

import { getStarfireCapability } from "../../packages/contracts/src/capabilities.js";

import { desktop } from "../lib/desktop.js";

const capability = getStarfireCapability("focus_app");

export default defineTool({
  description: capability.description,

  inputSchema: capability.parameters,

  async execute(input: { app: string }) {
    const { app } = input;

    const result = await desktop.apps.focus(app);

    return {
      summary:
        result.detail ??
        (result.focused
          ? `Brought ${app} to the front.`
          : `I couldn't bring ${app} to the front.`),

      app,
      focused: result.focused,
    };
  },
});
