import { defineTool } from "eve/tools";
import { z } from "zod";

import { desktop } from "../lib/desktop.js";

export default defineTool({
  description:
    "Get the current weather. Pass a place when the user asks " +
    "for weather somewhere else.",

  inputSchema: z.object({
    place: z.string().optional(),
  }),

  async execute({ place }) {
    const result = await desktop.weather.current(place);

    return {
      summary: result.summary,
      temperatureC: result.temperatureC,
      data: result.data ?? null,
    };
  },
});
