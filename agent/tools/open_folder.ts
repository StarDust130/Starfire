import { defineTool } from "eve/tools";
import { z } from "zod";

import { desktop } from "../lib/desktop.js";

export default defineTool({
  description: "Open a folder in the system file manager.",

  inputSchema: z.object({
    path: z.string().min(1),
  }),

  async execute({ path }) {
    const result = await desktop.files.openFolder(path);

    return {
      summary: `Opening ${result.opened}.`,
      path: result.opened,
    };
  },
});
