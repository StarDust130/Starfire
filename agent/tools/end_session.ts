import { defineTool } from "eve/tools";

export default defineTool({
  description:
    "End the current Starfire conversation. Use only when " +
    "the user clearly says goodbye or wants to stop.",

  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },

  async execute() {
    return {
      summary: "Waving goodbye and going to sleep. See you soon! ♡",
      endSession: true,
    };
  },
});
