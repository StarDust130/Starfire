import type { ToolManifest } from "@starfire/contracts";
import type { ToolDefinition } from "../registry.js";
import { ToolError } from "../tool-error.js";

export type WeatherAdapter = {
  current(place?: string): Promise<{
    summary: string;

    temperatureC: number | null;
  }>;
};

export function createGetWeatherTool(adapter: WeatherAdapter): ToolDefinition {
  const manifest: ToolManifest = {
    name: "get_weather",

    description:
      "Get the current weather. Without arguments it uses the user's " +
      "approximate location; pass a place for 'weather in Tokyo'.",

    danger: "safe",

    parameters: {
      type: "object",

      properties: {
        place: {
          type: "string",

          description:
            "Optional place name, e.g. 'Tokyo' or 'Berlin'. Omit for the user's approximate location.",
        },
      },

      required: [],
    },
  };

  return {
    manifest,

    async handle(args) {
      const place = typeof args.place === "string" ? args.place : undefined;

      const weather = await adapter.current(place);

      if (weather.temperatureC === null && weather.summary.length === 0) {
        throw new ToolError("I couldn't get the weather right now.");
      }

      return {
        summary: weather.summary,

        data: {
          place: place ?? "current location",

          temperatureC: weather.temperatureC,
        },
      };
    },
  };
}
