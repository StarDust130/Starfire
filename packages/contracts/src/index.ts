import { z } from "zod";

export const AgentRequestSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  text: z.string().min(1),
  source: z.literal("voice"),
});

export type AgentRequest = z.infer<typeof AgentRequestSchema>;

export const AgentResponseSchema = z.object({
  requestId: z.string().min(1),
  text: z.string(),
});

export type AgentResponse = z.infer<typeof AgentResponseSchema>;

export const ToolRequestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
});

export type ToolRequest = z.infer<typeof ToolRequestSchema>;

export type ToolResult =
  | {
      requestId: string;
      toolName: string;
      ok: true;
      output: unknown;
      durationMs: number;
    }
  | {
      requestId: string;
      toolName: string;
      ok: false;
      error: {
        code: string;
        message: string;
      };
      durationMs: number;
    };

export type ModelResponse =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "tool_call";
      tool: ToolRequest;
    };

export interface ModelProvider {
  readonly name: string;

  generate(input: { system?: string; user: string }): Promise<ModelResponse>;
}

export interface VoiceProvider {
  readonly name: string;

  respond(input: { audio: Uint8Array; sessionId: string }): Promise<{
    audio: Uint8Array;
  }>;
}

export interface Platform {
  openApp(appId: string): Promise<void>;
  readFile(path: string): Promise<string>;
}
