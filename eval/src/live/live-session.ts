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

const DEFAULT_ENDPOINT = `wss://api.empiriolabs.ai/v1/realtime?model=${REALTIME_MODEL}`;

const CONNECT_TIMEOUT_MS = 15000;

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

/*
 * A REAL Qwen realtime session. Utterances are sent as text turns
 * (input_text) over the same WebSocket production uses, the model's
 * tool calls execute through the REAL AgentRunner + ToolRegistry,
 * and results go back so the model generates its spoken answer.
 *
 * Only the OS ports are dry-run (no windows open during eval) —
 * every model decision, tool result, and network round-trip is real.
 */
export class LiveSession {
  private ws: WebSocket | null = null;

  private readonly registry: ReturnType<typeof createDefaultRegistry>;

  private readonly runner: AgentRunner;

  private readonly simState: SimState;

  private transcript = "";

  private functionCalls: LiveFunctionCall[] = [];

  private toolResults: ToolResult[] = [];

  private usage = { input: 0, output: 0 };

  private doneCount = 0;

  private toolsSinceDone = 0;

  private fatalError: string | null = null;

  constructor(simState: SimState) {
    this.simState = simState;

    this.registry = createDefaultRegistry(createEvalPorts(this.simState, []));

    this.runner = new AgentRunner({
      executor: this.registry,

      log: () => {},
    });
  }

  async connect(): Promise<void> {
    const key = process.env.EMPIRIOLABS_API_KEY;

    if (!key || key.trim().length === 0) {
      throw new Error("EMPIRIOLABS_API_KEY is not set.");
    }

    const ws = new WebSocket(DEFAULT_ENDPOINT, {
      headers: { Authorization: `Bearer ${key}` },
    });

    this.ws = ws;

    let settled = false;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;

          reject(new Error("connect timeout"));
        }
      }, CONNECT_TIMEOUT_MS);

      ws.on("message", (data) => {
        this.handleMessage(data.toString(), () => {
          if (!settled) {
            settled = true;

            clearTimeout(timer);

            resolve();
          }
        });
      });

      ws.on("error", (error) => {
        if (!settled) {
          settled = true;

          clearTimeout(timer);

          this.fatalError = error.message;

          reject(error);
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
        this.send(buildSessionUpdate(this.registry.functionTools()));
      }

      onReady?.();

      return;
    }

    if (event.kind === "function-call") {
      this.toolsSinceDone += 1;

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

      this.toolsSinceDone = 0;

      if (event.usage) {
        this.usage.input += event.usage.input_tokens ?? 0;

        this.usage.output += event.usage.output_tokens ?? 0;
      }

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
      this.send(
        buildFunctionCallOutput({
          callId: result.callId,

          ok: result.ok,

          summary: result.summary,

          data: result.data,
        }),
      );
    } else {
      this.send(
        buildFunctionCallOutput({
          callId,

          ok: false,

          summary: "no result",

          error: "internal-error",
        }),
      );
    }

    this.send(buildResponseCreate());
  }

  /**
   * Sends one utterance as a text turn and waits for the model's
   * complete answer (including any tool rounds it triggers). Usage is
   * reported as the per-turn delta of the session totals.
   */
  async ask(text: string, timeoutMs = 60000): Promise<LiveAskResult> {
    const started = Date.now();

    const usageBefore = { ...this.usage };

    this.transcript = "";

    this.functionCalls = [];

    this.toolResults = [];

    this.doneCount = 0;

    this.toolsSinceDone = 0;

    this.fatalError = null;

    this.send(buildConversationItemCreate(text));

    this.send(buildResponseCreate());

    while (Date.now() - started < timeoutMs) {
      if (this.fatalError) {
        break;
      }

      if (this.doneCount > 0 && this.toolsSinceDone === 0) {
        break;
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 60);
      });
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

  isAlive(): boolean {
    return (
      this.ws !== null &&
      this.ws.readyState === WebSocket.OPEN &&
      this.fatalError === null
    );
  }

  close(): void {
    const ws = this.ws;

    this.ws = null;

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
