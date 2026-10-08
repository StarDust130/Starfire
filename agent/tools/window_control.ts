import { defineTool } from "eve/tools";

import {
  getStarfireCapability,
  WINDOW_ACTION_SYNONYMS,
} from "../../packages/contracts/src/capabilities.js";

import { desktop } from "../lib/desktop.js";

const capability = getStarfireCapability("window_control");

export default defineTool({
  description: capability.description,

  inputSchema: capability.parameters,

  async execute(input: {
    action: keyof typeof WINDOW_ACTION_SYNONYMS;
    app?: string;
  }) {
    const canonical = WINDOW_ACTION_SYNONYMS[input.action];

    const result = await desktop.windows.control(canonical, input.app);

    if (!result.done) {
      throw new Error(
        result.detail ?? "That window action didn't work right now.",
      );
    }

    const messages = {
      focus: "Brought it to the front.",
      lower: "Sent it behind the other windows.",
      minimize: "Minimized.",
      maximize: "Maximized.",
      restore: "Restored.",
    } as const;

    return {
      summary: messages[canonical],
      action: canonical,
      app: input.app ?? null,
    };
  },
});
