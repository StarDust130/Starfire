import { defineTool } from "eve/tools";
import { z } from "zod";

import { desktop } from "../lib/desktop.js";

export default defineTool({
  description:
    "Launch a desktop application. Use for requests like " +
    '"open VS Code", "start Discord", or "launch Calculator".',

  inputSchema: z.object({
    app: z.string().min(1),
  }),

  async execute({ app }) {
    const opened = await desktop.apps.open(app);

    return {
      summary: `Opening ${opened.name}.`,
      app: opened.name,
      pid: opened.pid ?? null,
    };
  },
});
