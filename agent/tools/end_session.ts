import { defineTool } from "eve/tools";

import { getStarfireCapability } from "../../packages/contracts/src/capabilities.js";

import { endSessionResult } from "../../packages/contracts/src/dispatch.js";

const capability = getStarfireCapability("end_session");

export default defineTool({
  description: capability.description,

  inputSchema: capability.parameters,

  async execute() {
    return endSessionResult();
  },
});
