import { z } from "zod";

export const ToolRequestSchema = z.object({
  tool: z.string(),
  arguments: z.record(z.string(), z.unknown())
});

export type ToolRequest = z.infer<typeof ToolRequestSchema>;
