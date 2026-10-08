import { defineTool } from "eve/tools";

import { getStarfireCapability } from "../../packages/contracts/src/capabilities.js";

import { desktop } from "../lib/desktop.js";

const capability = getStarfireCapability("clipboard");

export default defineTool({
  description: capability.description,

  inputSchema: capability.parameters,

  async execute(input: { action: "read" | "write"; text?: string }) {
    if (input.action === "write") {
      const text = input.text;

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
