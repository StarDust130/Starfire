import type { ToolCall, ToolContext, ToolResult } from "@starfire/contracts";

/**
 * The one method the runner needs. ToolRegistry satisfies this
 * structurally — tests can inject minimal fakes without the real
 * class.
 */
export type ToolExecutor = {
  execute(call: ToolCall, ctx?: ToolContext): Promise<ToolResult>;
};

export type AgentRunnerOptions = {
  executor: ToolExecutor;

  /**
   * Safety cap: how many tool calls the model may request in one
   * turn. Extras are skipped and logged. Prevents a confused model
   * from machine-gunning the OS.
   */
  maxCallsPerTurn?: number;

  log?: (message: string) => void;
};

export type AgentTurnEvent =
  | { kind: "turn-started"; received: number; executing: number }
  | { kind: "call-result"; result: ToolResult }
  | { kind: "turn-completed"; total: number; ok: number; failed: number };

const DEFAULT_MAX_CALLS_PER_TURN = 4;

/*
 * V0 tool calls are executed SEQUENTIALLY, in the order the model
 * emitted them. Parallel OS actions (open two apps at once) can race
 * and confuse the user; there is no latency win worth that in V0.
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

    const overflow = usable.length - executing.length;

    if (malformed > 0) {
      this.log(`agent: skipped ${malformed} malformed tool call(s)`);
    }

    if (overflow > 0) {
      this.log(
        `agent: turn requested ${usable.length} calls — ` +
          `executing first ${executing.length} (cap ${this.maxCallsPerTurn})`,
      );
    }

    this.listener?.({
      kind: "turn-started",

      received,

      executing: executing.length,
    });

    const results: ToolResult[] = [];

    for (const call of executing) {
      const result = await this.executeSafely(call, ctx);

      results.push(result);

      this.listener?.({ kind: "call-result", result });
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

  /*
   * The registry already never throws, but the executor is injected —
   * a broken one must degrade to a per-call failure, never kill the
   * voice session.
   */
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
