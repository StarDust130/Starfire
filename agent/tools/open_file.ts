import { defineTool } from "eve/tools";

import { getStarfireCapability } from "../../packages/contracts/src/capabilities.js";

import { desktop } from "../lib/desktop.js";

const capability = getStarfireCapability("open_file");

export default defineTool({
  description: capability.description,

  inputSchema: capability.parameters,

  async execute(input: { path: string }) {
    const result = await desktop.files.openFile(input.path);

    return {
      summary: `Opening ${result.opened}.`,
      path: result.opened,
    };
  },
});
