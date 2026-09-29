import WebSocket from "ws";

import { AgentRunner } from "../../../apps/core/src/index.ts";

import {
  buildConversationItemCreate,
  buildFunctionCallOutput,
  buildResponseCreate,
  buildSessionUpdate,
  parseServerEvent,
  REALTIME_MODEL,
} from "../../../apps/desktop/electron/realtimeProtocol.ts";
import type { ToolResult } from "../../../packages/contracts/src/index.ts";
import { createDefaultRegistry } from "../../../packages/tools/src/index.ts";

import { createEvalPorts, type SimState } from "../ports.js";

import { createRateLimiter, type RateLimiter } from "./rate-limiter.js";

const DEFAULT_ENDPOINT = `wss://api.empiriolabs.ai/v1/realtime?model=${REALTIME_MODEL}`;

const CONNECT_TIMEOUT_MS = 15000;

/*
 * Instruction context is re-sent on every session (2.5k+ tokens);
 * each turn adds ~1k. Used for rate-limit projections.
 */
const SESSION_OVERHEAD_TOKENS = 2600;

const TURN_OVERHEAD_TOKENS = 900;

export type LiveFunctionCall = {
  name: string;

  args: unknown;
};

export type LiveAskResult = {
  transcript: string;

  functionCalls: LiveFunctionCall[];

  toolResults: ToolResult[];

  durationMs: number;

  usage: { input: number; output: number };
};

export class LiveSessionClosedError extends Error {
  constructor(
    message: string,

    readonly code: number | "error",
  ) {
    super(message);

    this.name = "LiveSessionClosedError";
  }
}

/*
 * A persistent REAL Qwen realtime session, reused across many eval
 * cases (like a real user conversation) so providers never see a
 * 47-socket burst. Utterances are text turns; tool calls execute
 * through the REAL AgentRunner + ToolRegistry. All sends pass through
 * the account-level rate limiter.
 *
 * ask() waits for the WHOLE turn: the model's function-call response
 * AND the follow-up spoken response after the tool output is fed
 * back. It THROWS on fatal server errors so the runner's backoff
 * ladder can engage — a silent empty turn is never acceptable.
 */
export class LiveSession {
  private ws: WebSocket | null = null;

  private readonly registry: ReturnType<typeof createDefaultRegistry>;

  private readonly runner: AgentRunner;

  private readonly simState: SimState;

  private readonly limiter: RateLimiter;

  private transcript = "";

  private functionCalls: LiveFunctionCall[] = [];

  private toolResults: ToolResult[] = [];

  private usage = { input: 0, output: 0 };

  private doneCount = 0;

  private toolsPendingResponse = 0;

  private fatalError: string | null = null;

  private closed = false;

  constructor(simState: SimState) {
    this.simState = simState;

    this.limiter = createRateLimiter();

    this.registry = createDefaultRegistry(createEvalPorts(this.simState, []));

    this.runner = new AgentRunner({
      executor: this.registry,

      log: () => {},
    });
  }

  isAlive(): boolean {
    return (
      this.ws !== null &&
      this.ws.readyState === WebSocket.OPEN &&
      this.fatalError === null &&
      !this.closed
    );
  }

  isReady(): boolean {
    return this.isAlive();
  }

  private async sendLimited(
    payload: string,
    estimatedTokens: number,
  ): Promise<boolean> {
    await this.limiter.acquire(estimatedTokens);

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    this.ws.send(payload);

    return true;
  }

  /**
   * Opens the socket (or reopens if it died) and waits until the
   * session is configured. handleMessage receives an onReady callback
   * that fires exactly when session.created has been handled.
   */
  async ensureConnected(): Promise<void> {
    if (this.isAlive()) {
      return;
    }

    if (this.ws) {
      this.close();
    }

    const key = process.env.EMPIRIOLABS_API_KEY;

    if (!key || key.trim().length === 0) {
      throw new Error("EMPIRIOLABS_API_KEY is not set.");
    }

    const endpoint = process.env.EMPIRIOLABS_REALTIME_URL ?? DEFAULT_ENDPOINT;

    const ws = new WebSocket(endpoint, {
      headers: { Authorization: `Bearer ${key}` },
    });

    this.ws = ws;

    this.closed = false;

    this.fatalError = null;

    let settled = false;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;

          reject(new Error("connect timeout"));
        }
      }, CONNECT_TIMEOUT_MS);

      ws.on("message", (data) => {
        this.handleMessage(
          data.toString(),

          () => {
            if (!settled) {
              settled = true;

              clearTimeout(timer);

              resolve();
            }
          },
        );
      });

      ws.on("error", (error) => {
        if (!settled) {
          settled = true;

          clearTimeout(timer);

          this.fatalError = error.message;

          reject(error);
        }
      });

      ws.on("close", (code) => {
        if (!settled) {
          settled = true;

          clearTimeout(timer);

          this.closed = true;

          reject(new LiveSessionClosedError(`socket closed: ${code}`, code));
        }
      });
    });
  }

  private handleMessage(raw: string, onReady?: () => void): void {
    const event = parseServerEvent(raw);

    if (!event) {
      return;
    }

    if (event.kind === "session") {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        void this.sendLimited(
          buildSessionUpdate(this.registry.functionTools()),

          SESSION_OVERHEAD_TOKENS,
        );
      }

      onReady?.();

      return;
    }

    if (event.kind === "function-call") {
      this.toolsPendingResponse += 1;

      this.functionCalls.push({
        name: event.name,

        args: event.args,
      });

      void this.executeTool(event.callId, event.name, event.args);

      return;
    }

    /*
     * The assistant's spoken reply arrives as transcript deltas
     * (response.audio_transcript.delta -> kind "transcript-delta").
     */
    if (event.kind === "transcript-delta") {
      this.transcript += event.delta;

      return;
    }

    if (event.kind === "response-done") {
      this.doneCount += 1;

      this.toolsPendingResponse = 0;

      if (event.usage) {
        this.usage.input += event.usage.input_tokens ?? 0;

        this.usage.output += event.usage.output_tokens ?? 0;
      }

      return;
    }

    if (event.kind === "response-cancelled") {
      this.toolsPendingResponse = 0;

      return;
    }

    if (event.kind === "error") {
      if (!this.fatalError) {
        this.fatalError = event.message;
      }

      return;
    }
  }

  private async executeTool(
    callId: string,
    name: string,
    args: unknown,
  ): Promise<void> {
    const results = await this.runner.run(
      [{ callId, name, args }],

      { log: () => {} },
    );

    const result = results[0];

    this.toolResults.push(
      result ?? {
        callId,

        ok: false,

        summary: "tool produced no result",

        error: "internal-error",
      },
    );

    if (result) {
      await this.sendLimited(
        buildFunctionCallOutput({
          callId: result.callId,

          ok: result.ok,

          summary: result.summary,

          data: result.data,
        }),

        400,
      );
    } else {
      await this.sendLimited(
        buildFunctionCallOutput({
          callId,

          ok: false,

          summary: "no result",

          error: "internal-error",
        }),

        100,
      );
    }

    await this.sendLimited(buildResponseCreate(), 20);
  }

  /**
   * Sends one utterance as a text turn and waits for the COMPLETE
   * answer: the response.done for the initial turn AND every tool
   * round-trip that follows. THROWS on fatal server errors and
   * socket death so the runner's backoff ladder can engage — a
   * silent empty turn is never acceptable. Usage is reported as the
   * per-turn delta of the session totals.
   */
  async ask(text: string, timeoutMs = 60000): Promise<LiveAskResult> {
    await this.ensureConnected();

    const started = Date.now();

    const doneAtStart = this.doneCount;

    const usageBefore = { ...this.usage };

    this.transcript = "";

    this.functionCalls = [];

    this.toolResults = [];

    this.fatalError = null;

    await this.sendLimited(
      buildConversationItemCreate(text),

      TURN_OVERHEAD_TOKENS,
    );

    await this.sendLimited(buildResponseCreate(), 20);

    while (Date.now() - started < timeoutMs) {
      if (!this.isAlive()) {
        throw new LiveSessionClosedError(
          this.fatalError ?? "socket closed during turn",

          "error",
        );
      }

      if (this.fatalError) {
        throw new LiveSessionClosedError(this.fatalError, "error");
      }

      /*
       * Turn complete = at least one NEW response.done AND no tool
       * round still awaiting its follow-up response.
       */
      if (this.doneCount > doneAtStart && this.toolsPendingResponse === 0) {
        break;
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 60);
      });
    }

    if (this.fatalError) {
      throw new LiveSessionClosedError(this.fatalError, "error");
    }

    const durationMs = Date.now() - started;

    const usage = {
      input: this.usage.input - usageBefore.input,

      output: this.usage.output - usageBefore.output,
    };

    return {
      transcript: this.transcript,

      functionCalls: [...this.functionCalls],

      toolResults: [...this.toolResults],

      durationMs,

      usage,
    };
  }

  private send(payload: string): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(payload);

      return true;
    }

    return false;
  }

  close(): void {
    const ws = this.ws;

    this.ws = null;

    this.closed = true;

    if (!ws) {
      return;
    }

    try {
      ws.close(1000);
    } catch {
      try {
        ws.terminate();
      } catch {
        // already dead
      }
    }
  }
}
