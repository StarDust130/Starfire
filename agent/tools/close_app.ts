import { defineTool } from "eve/tools";
import { z } from "zod";

import { desktop } from "../lib/desktop.js";

export default defineTool({
  description: "Close a running desktop application gracefully.",

  inputSchema: z.object({
    app: z.string().min(1),
  }),

  async execute({ app }) {
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
