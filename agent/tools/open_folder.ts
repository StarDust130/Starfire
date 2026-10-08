import { defineTool } from "eve/tools";

import { getStarfireCapability } from "../../packages/contracts/src/capabilities.js";

import { desktop } from "../lib/desktop.js";

const capability = getStarfireCapability("open_folder");

export default defineTool({
  description: capability.description,

  inputSchema: capability.parameters,

  async execute(input: { path: string }) {
    const result = await desktop.files.openFolder(input.path);

    return {
      summary: `Opening ${result.opened}.`,
      path: result.opened,
    };
  },
});
