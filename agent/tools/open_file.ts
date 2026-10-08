import { defineTool } from "eve/tools";
import { z } from "zod";

import { desktop } from "../lib/desktop.js";

export default defineTool({
  description: "Open a file with its default application.",

  inputSchema: z.object({
    path: z.string().min(1),
  }),

  async execute({ path }) {
    const result = await desktop.files.openFile(path);

    return {
      summary: `Opening ${result.opened}.`,
      path: result.opened,
    };
  },
});
