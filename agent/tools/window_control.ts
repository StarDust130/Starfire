import { defineTool } from "eve/tools";
import { z } from "zod";

import { desktop } from "../lib/desktop.js";

const SYNONYMS = {
  focus: "focus",
  raise: "focus",
  front: "focus",
  "bring-to-front": "focus",
  "bring-to-the-front": "focus",
  activate: "focus",

  lower: "lower",
  back: "lower",
  "send-to-back": "lower",
  "send-behind": "lower",

  minimize: "minimize",
  maximize: "maximize",

  restore: "restore",
  unminimize: "restore",
} as const;

const actionSchema = z.enum(
  Object.keys(SYNONYMS) as [
    keyof typeof SYNONYMS,
    ...(keyof typeof SYNONYMS)[],
  ],
);

export default defineTool({
  description:
    "Control a desktop window: focus, lower, minimize, " +
    "maximize, or restore.",

  inputSchema: z.object({
    action: actionSchema,
    app: z.string().optional(),
  }),

  async execute({ action, app }) {
    const canonical = SYNONYMS[action];

    const result = await desktop.windows.control(canonical, app);

    if (!result.done) {
      throw new Error(
        result.detail ?? "That window action didn't work right now.",
      );
    }

    const messages = {
      focus: "Brought it to the front.",
      lower: "Sent it behind the other windows.",
      minimize: "Minimized.",
      maximize: "Maximized.",
      restore: "Restored.",
    } as const;

    return {
      summary: messages[canonical],
      action: canonical,
      app: app ?? null,
    };
  },
});
