import { defineTool } from "eve/tools";

const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export default defineTool({
  description: "Get the current local date, time, weekday, and timezone.",

  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },

  async execute() {
    const now = new Date();

    const date = now.toLocaleDateString("en-CA");
    const time = now.toLocaleTimeString("en-GB");
    const day = DAYS[now.getDay()] ?? "unknown day";

    const timezone =
      Intl.DateTimeFormat().resolvedOptions().timeZone ?? "local timezone";

    return {
      summary: `It's ${time} on ${day}, ${date} (${timezone}).`,
      date,
      time,
      day,
      timezone,
    };
  },
});
