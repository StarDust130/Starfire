import type { ToolManifest } from "@starfire/contracts";
import type { ToolDefinition } from "../registry.js";
import { ToolError } from "../tool-error.js";

const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export type ClockPort = {
  now(): number;
};

/**
 * Clock is injectable for deterministic tests; production passes
 * () => Date.now().
 */
export function createCurrentDateTimeTool(
  clock: ClockPort = { now: () => Date.now() },
): ToolDefinition {
  const manifest: ToolManifest = {
    name: "current_date_time",

    description:
      "Get the current local date, time, day of the week, and timezone. " +
      "Use for 'what time is it?', 'what's today's date?', 'what day is today?'.",

    danger: "safe",

    parameters: {
      type: "object",

      properties: {},

      required: [],
    },
  };

  return {
    manifest,

    async handle() {
      const now = new Date(clock.now());

      if (Number.isNaN(now.getTime())) {
        throw new ToolError("I couldn't read the system clock.");
      }

      const date = now.toLocaleDateString("en-CA");

      const time = now.toLocaleTimeString("en-GB");

      const day = DAYS[now.getDay()] ?? "unknown day";

      const timezone =
        Intl.DateTimeFormat().resolvedOptions().timeZone ?? "local timezone";

      return {
        summary: `It's ${time} on ${day}, ${date} (${timezone}).`,

        data: {
          date,

          time,

          day,

          timezone,
        },
      };
    },
  };
}
