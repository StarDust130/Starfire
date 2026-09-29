import type {
  ToolCall,
  ToolContext,
  ToolManifest,
  ToolOutput,
  ToolParameterSchema,
  ToolResult,
} from "@starfire/contracts";

import { ToolError } from "./tool-error.js";

import { type ValidatedArgs, validateToolArgs } from "./validate.js";

export type ToolHandler = (
  args: ValidatedArgs,
  ctx: ToolContext,
) => Promise<ToolOutput>;

export type ToolDefinition = {
  manifest: ToolManifest;

  handle: ToolHandler;
};

export type ToolRegistryOptions = {
  /**
   * Hard cap per tool call. A hung tool must never hang her voice
   * session — the model gets a friendly "took too long" and can
   * recover.
   */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10000;

export type FunctionTool = {
  type: "function";

  name: string;

  description: string;

  parameters: ToolParameterSchema;
};

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  private readonly timeoutMs: number;

  constructor(options: ToolRegistryOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  register(definition: ToolDefinition): void {
    if (this.tools.has(definition.manifest.name)) {
      throw new Error(
        `Tool "${definition.manifest.name}" is already registered.`,
      );
    }

    this.tools.set(definition.manifest.name, definition);
  }

  registerAll(definitions: ToolDefinition[]): void {
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  manifests(): ToolManifest[] {
    return [...this.tools.values()].map((tool) => tool.manifest);
  }

  /**
   * The exact shape Qwen's session config expects for function tools.
   */
  functionTools(): FunctionTool[] {
    return this.manifests().map((manifest) => ({
      type: "function",

      name: manifest.name,

      description: manifest.description,

      parameters: manifest.parameters,
    }));
  }

  async execute(call: ToolCall, ctx: ToolContext = {}): Promise<ToolResult> {
    const tool = this.tools.get(call.name);

    if (!tool) {
      return {
        callId: call.callId,

        ok: false,

        summary: `I don't have a "${call.name}" tool available.`,

        error: "unknown-tool",
      };
    }

    /*
     * Models sometimes send null or omit arguments entirely for
     * zero-argument tools. Treat that as an empty object so "no
     * arguments" tools work naturally.
     */
    const validated = validateToolArgs(
      tool.manifest.parameters,
      call.args ?? {},
    );

    if (!validated.ok) {
      return {
        callId: call.callId,

        ok: false,

        summary: `I couldn't use the ${tool.manifest.name} tool: ${validated.error}.`,

        error: "invalid-args",
      };
    }

    try {
      const output = await this.withTimeout(
        tool.handle(validated.value, ctx),
        tool.manifest.name,
      );

      return {
        callId: call.callId,

        ok: true,

        summary: output.summary,

        data: output.data,
      };
    } catch (error) {
      if (error instanceof ToolError) {
        return {
          callId: call.callId,

          ok: false,

          summary: error.message,

          error: "tool-error",
        };
      }

      ctx.log?.(`tool ${tool.manifest.name} failed: ${String(error)}`);

      return {
        callId: call.callId,

        ok: false,

        summary: "That action didn't work — something went wrong on my side.",

        error: "internal-error",
      };
    }
  }

  private async withTimeout(
    promise: Promise<ToolOutput>,
    name: string,
  ): Promise<ToolOutput> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<ToolOutput>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new ToolError(`The ${name} action took too long.`));
      }, this.timeoutMs);
    });

    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}
