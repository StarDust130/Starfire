import { defineTool } from "eve/tools";

import { getStarfireCapability } from "../../packages/contracts/src/capabilities.js";

import { desktop } from "../lib/desktop.js";

const capability = getStarfireCapability("get_weather");

export default defineTool({
  description: capability.description,

  inputSchema: capability.parameters,

  async execute(input: { place?: string }) {
    const result = await desktop.weather.current(input.place);

    return {
      summary: result.summary,
      temperatureC: result.temperatureC,
      data: result.data ?? null,
    };
  },
});
