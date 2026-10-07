import type { ToolCall, ToolContext, ToolResult } from "@starfire/contracts";

/**
 * The one method the runner needs.
 * ToolRegistry satisfies this structurally.
 */
export type ToolExecutor = {
  execute(call: ToolCall, ctx?: ToolContext): Promise<ToolResult>;
};

export type AgentRunnerOptions = {
  executor: ToolExecutor;

  /**
   * Maximum number of tool calls allowed in one turn.
   *
   * IMPORTANT:
   * The caller must pass all calls belonging to the same
   * model response to ONE run() call.
   */
  maxCallsPerTurn?: number;

  log?: (message: string) => void;
};

export type AgentTurnEvent =
  | {
      kind: "turn-started";
      received: number;
      executing: number;
    }
  | {
      kind: "call-result";
      result: ToolResult;
    }
  | {
      kind: "turn-completed";
      total: number;
      ok: number;
      failed: number;
    };

const DEFAULT_MAX_CALLS_PER_TURN = 4;

/*
 * V0 executes tool calls sequentially.
 *
 * The runner also returns explicit failures for calls above the cap.
 * This is important because the realtime model still needs a result
 * for every valid function call it emitted.
 */
export class AgentRunner {
  private readonly executor: ToolExecutor;

  private readonly maxCallsPerTurn: number;

  private readonly log: (message: string) => void;

  private readonly listener?: (event: AgentTurnEvent) => void;

  constructor(
    options: AgentRunnerOptions & {
      onEvent?: (event: AgentTurnEvent) => void;
    },
  ) {
    this.executor = options.executor;

    this.maxCallsPerTurn =
      options.maxCallsPerTurn ?? DEFAULT_MAX_CALLS_PER_TURN;

    if (!Number.isInteger(this.maxCallsPerTurn) || this.maxCallsPerTurn < 1) {
      throw new Error("maxCallsPerTurn must be a positive integer.");
    }

    this.log = options.log ?? (() => {});

    this.listener = options.onEvent;
  }

  async run(calls: ToolCall[], ctx: ToolContext = {}): Promise<ToolResult[]> {
    const received = calls.length;

    const usable = calls.filter(
      (call) =>
        typeof call.callId === "string" &&
        call.callId.length > 0 &&
        typeof call.name === "string" &&
        call.name.length > 0,
    );

    const malformed = received - usable.length;

    const executing = usable.slice(0, this.maxCallsPerTurn);

    const overflow = usable.slice(this.maxCallsPerTurn);

    if (malformed > 0) {
      this.log(`agent: skipped ${malformed} malformed tool call(s)`);
    }

    if (overflow.length > 0) {
      this.log(
        `agent: turn requested ${usable.length} calls — ` +
          `executing first ${executing.length} ` +
          `(cap ${this.maxCallsPerTurn})`,
      );
    }

    this.listener?.({
      kind: "turn-started",
      received,
      executing: executing.length,
    });

    const results: ToolResult[] = [];

    /*
     * Execute allowed calls sequentially.
     */
    for (const call of executing) {
      const result = await this.executeSafely(call, ctx);

      results.push(result);

      this.listener?.({
        kind: "call-result",
        result,
      });
    }

    /*
     * Calls above the cap are rejected explicitly.
     *
     * Do NOT silently drop them because the realtime model needs
     * a function_call_output for every valid call it emitted.
     */
    for (const call of overflow) {
      const result: ToolResult = {
        callId: call.callId,

        ok: false,

        summary:
          `I can only perform up to ` +
          `${this.maxCallsPerTurn} actions ` +
          `in one turn.`,

        error: "tool-limit-exceeded",
      };

      results.push(result);

      this.listener?.({
        kind: "call-result",
        result,
      });
    }

    const ok = results.filter((result) => result.ok).length;

    this.listener?.({
      kind: "turn-completed",

      total: results.length,

      ok,

      failed: results.length - ok,
    });

    return results;
  }

  private async executeSafely(
    call: ToolCall,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    try {
      return await this.executor.execute(call, ctx);
    } catch (error) {
      this.log(`agent: executor threw for ${call.name}: ${String(error)}`);

      return {
        callId: call.callId,

        ok: false,

        summary: "That action didn't work — something went wrong on my side.",

        error: "internal-error",
      };
    }
  }
}
