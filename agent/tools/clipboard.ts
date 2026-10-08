import { defineTool } from "eve/tools";
import { z } from "zod";

import { desktop } from "../lib/desktop.js";

export default defineTool({
  description:
    "Read or write the system clipboard. Use read for " +
    '"what did I copy?" and write to copy text for the user.',

  inputSchema: z.object({
    action: z.enum(["read", "write"]),
    text: z.string().optional(),
  }),

  async execute({ action, text }) {
    if (action === "write") {
      if (!text || text.trim().length === 0) {
        throw new Error("What should I copy? Tell me the text first.");
      }

      await desktop.clipboard.write(text);

      return {
        summary: "Copied that to your clipboard.",
        length: text.length,
      };
    }

    const result = await desktop.clipboard.read();

    if (!result.text.trim()) {
      return {
        summary: "Your clipboard is empty.",
        empty: true,
      };
    }

    const preview =
      result.text.length > 160 ? `${result.text.slice(0, 160)}…` : result.text;

    return {
      summary: `Your clipboard says: "${preview}"`,
      length: result.text.length,
    };
  },
});
