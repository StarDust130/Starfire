import type {
  ToolCall,
  ToolContext,
  ToolManifest,
  ToolOutput,
  ToolParameterSchema,
  ToolResult,
} from "@starfire/contracts";

import { toolPolicies } from "./policy.js";
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
   * Hard cap per tool call.
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
    const name = definition.manifest.name;

    if (this.tools.has(name)) {
      throw new Error(`Tool "${name}" is already registered.`);
    }

    const policy = toolPolicies[name];

    if (!policy) {
      throw new Error(`Tool "${name}" has no safety policy.`);
    }

    this.tools.set(name, definition);
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
   * Exact function-tool shape sent to Qwen.
   *
   * Notice that safety policy is NOT decided by Qwen.
   * Qwen can request a tool, but the Registry makes the final
   * runtime safety decision.
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
    /*
     * 1. Find the tool.
     */
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
     * 2. Validate arguments BEFORE confirmation.
     *
     * The confirmation UI should only see valid arguments.
     */
    const validated = validateToolArgs(
      tool.manifest.parameters,
      call.args ?? {},
    );

    if (!validated.ok) {
      return {
        callId: call.callId,

        ok: false,

        summary:
          `I couldn't use the ${tool.manifest.name} tool: ` +
          `${validated.error}.`,

        error: "invalid-args",
      };
    }

    /*
     * 3. Get runtime policy.
     */
    const policy = toolPolicies[tool.manifest.name];

    if (!policy) {
      return {
        callId: call.callId,

        ok: false,

        summary: `The ${tool.manifest.name} tool has no safety policy.`,

        error: "policy-denied",
      };
    }

    /*
     * 4. Disabled tool = never execute.
     */
    if (!policy.enabled) {
      return {
        callId: call.callId,

        ok: false,

        summary: `The ${tool.manifest.name} tool is currently disabled.`,

        error: "policy-denied",
      };
    }

    /*
     * 5. Dangerous tool = require explicit user approval.
     *
     * `danger` is the single source of truth for confirmation.
     */
    if (tool.manifest.danger === "confirm") {
      if (!ctx.confirm) {
        return {
          callId: call.callId,

          ok: false,

          summary:
            `The ${tool.manifest.name} action requires ` + `your confirmation.`,

          error: "confirmation-required",
        };
      }

      let approved: boolean;

      try {
        approved = await ctx.confirm({
          tool: tool.manifest.name,

          args: validated.value,

          reason: `Starfire wants to run ${tool.manifest.name}.`,
        });
      } catch (error) {
        ctx.log?.(
          `confirmation failed for ${tool.manifest.name}: ${String(error)}`,
        );

        /*
         * Fail closed.
         * If the confirmation system breaks, the action must NOT run.
         */
        return {
          callId: call.callId,

          ok: false,

          summary:
            `I couldn't get confirmation for ` +
            `${tool.manifest.name}, so I didn't run it.`,

          error: "confirmation-denied",
        };
      }

      if (!approved) {
        return {
          callId: call.callId,

          ok: false,

          summary: `The ${tool.manifest.name} action was not approved.`,

          error: "confirmation-denied",
        };
      }
    }

    /*
     * 6. Finally execute the tool.
     */
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
