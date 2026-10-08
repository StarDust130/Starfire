import { defineTool } from "eve/tools";
import { z } from "zod";

import { desktop } from "../lib/desktop.js";

export default defineTool({
  description: "Bring a desktop application's window to the front.",

  inputSchema: z.object({
    app: z.string().min(1),
  }),

  async execute({ app }) {
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
