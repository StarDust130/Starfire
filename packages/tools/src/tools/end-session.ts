import type { ToolManifest } from "@starfire/contracts";

import type { ToolDefinition } from "../registry.js";

export function createEndSessionTool(): ToolDefinition {
  const manifest: ToolManifest = {
    name: "end_session",

    description:
      "End the conversation and go to sleep. Use ONLY when the user is " +
      "saying goodbye — 'thanks bye', 'goodbye', 'that's all', " +
      "'see you later'. Say a short warm goodbye.",

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
      /*
       * The REAL session close is performed by the realtime bridge
       * when it sees this tool call — it lets her speak the goodbye
       * first, then disconnects and the wake word resumes.
       */
      return {
        summary: "Waving goodbye and going to sleep. See you soon! ♡",
      };
    },
  };
}
