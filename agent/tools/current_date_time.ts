import { defineTool } from "eve/tools";

import { getStarfireCapability } from "../../packages/contracts/src/capabilities.js";

import { currentDateTimeResult } from "../../packages/contracts/src/dispatch.js";

const capability = getStarfireCapability("current_date_time");

export default defineTool({
  description: capability.description,

  inputSchema: capability.parameters,

  async execute() {
    return currentDateTimeResult();
  },
});
