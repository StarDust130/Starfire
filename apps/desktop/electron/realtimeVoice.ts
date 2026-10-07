import { AgentRunner } from "@starfire/core";
import { createDefaultRegistry } from "@starfire/tools";
import { type BrowserWindow, ipcMain } from "electron";
import WebSocket from "ws";

import { createElectronPorts } from "./agent/electron-ports.js";

import {
  buildAudioAppend,
  buildFunctionCallOutput,
  buildResponseCancel,
  buildResponseCreate,
  buildSessionUpdate,
  parseServerEvent,
  REALTIME_MODEL,
} from "./realtimeProtocol";

const DEFAULT_ENDPOINT = `wss://api.empiriolabs.ai/v1/realtime?model=${REALTIME_MODEL}`;

const CONNECT_TIMEOUT_MS = 10000;

export type VoiceStartResult =
  | { ok: true; conn: number }
  | { ok: false; error: string; fatal: boolean };

type PendingStart = {
  resolve: (result: VoiceStartResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

type FunctionCallEvent = {
  callId: string;
  name: string;
  args: unknown;
};

/*
 * Owns the EmpirioLabs realtime WebSocket, the API key, and the agent bridge.
 *
 * Flow:
 *
 *   Qwen function calls
 *        ↓
 *   collect all calls from this response
 *        ↓
 *   AgentRunner.run(...)
 *        ↓
 *   ToolRegistry
 *        ↓
 *   real Electron ports
 *        ↓
 *   send every tool result back to Qwen
 *        ↓
 *   Qwen speaks the result
 */
export class RealtimeVoiceBridge {
  private socket: WebSocket | null = null;

  private pending: PendingStart | null = null;

  private conn = 0;

  private sessionConfigured = false;

  private sessionAnnounced = false;

  private sessionConfirmedLogged = false;

  private responseStartedAt = 0;

  private firstAudioLogged = false;

  private audioChunks = 0;

  private audioBytes = 0;

  /*
   * A single model response can contain multiple function calls.
   * We collect them and execute them together through ONE AgentRunner.run()
   * call so maxCallsPerTurn is actually enforced.
   */
  private readonly registry: ReturnType<typeof createDefaultRegistry>;

  private readonly runner: AgentRunner;

  private pendingToolCalls: FunctionCallEvent[] = [];

  private toolBatchStarted = false;

  private toolBatchCancelled = false;

  private pendingSessionEnd = false;

  constructor(private readonly getWindow: () => BrowserWindow | null) {
    this.registry = createDefaultRegistry(createElectronPorts());

    this.runner = new AgentRunner({
      executor: this.registry,
      log: (message) => console.log(`[Starfire Voice] ${message}`),
    });
  }

  register(): void {
    ipcMain.handle("starfire-voice:start", () => this.handleStart());

    ipcMain.on("starfire-voice:audio", (_event, audio: unknown) => {
      this.handleAudio(audio);
    });

    ipcMain.on("starfire-voice:interrupt", () => {
      this.handleInterrupt();
    });

    ipcMain.handle("starfire-voice:stop", () => {
      this.closeSocket(1000);
    });

    ipcMain.on("starfire-voice:log", (_event, message: unknown) => {
      if (
        typeof message === "string" &&
        message.length > 0 &&
        message.length <= 300
      ) {
        console.log(`[Starfire Voice] ${message}`);
      }
    });
  }

  async dispose(): Promise<void> {
    ipcMain.removeHandler("starfire-voice:start");
    ipcMain.removeHandler("starfire-voice:stop");

    ipcMain.removeAllListeners("starfire-voice:audio");
    ipcMain.removeAllListeners("starfire-voice:interrupt");
    ipcMain.removeAllListeners("starfire-voice:log");

    this.closeSocket(1000);
  }

  private emit(payload: Record<string, unknown>): void {
    const win = this.getWindow();

    if (win && !win.isDestroyed()) {
      win.webContents.send("starfire-voice:event", {
        conn: this.conn,
        ...payload,
      });
    }
  }

  private emitAudio(pcm: Buffer): void {
    const win = this.getWindow();

    if (win && !win.isDestroyed()) {
      win.webContents.send("starfire-voice:audio", pcm);
    }
  }

  private handleStart(): Promise<VoiceStartResult> {
    const key = process.env.EMPIRIOLABS_API_KEY;

    if (!key || key.trim().length === 0) {
      return Promise.resolve({
        ok: false,
        error: "EmpirioLabs API key is not configured.",
        fatal: true,
      });
    }

    if (this.socket) {
      return Promise.resolve({
        ok: false,
        error: "A voice session is already active.",
        fatal: false,
      });
    }

    this.conn += 1;

    this.sessionConfigured = false;
    this.sessionAnnounced = false;
    this.sessionConfirmedLogged = false;

    this.responseStartedAt = 0;
    this.firstAudioLogged = false;
    this.audioChunks = 0;
    this.audioBytes = 0;

    this.pendingToolCalls = [];
    this.toolBatchStarted = false;
    this.toolBatchCancelled = false;
    this.pendingSessionEnd = false;

    const endpoint = process.env.EMPIRIOLABS_REALTIME_URL ?? DEFAULT_ENDPOINT;

    const socket = new WebSocket(endpoint, {
      headers: {
        Authorization: `Bearer ${key}`,
      },
    });

    this.socket = socket;

    console.log("[Starfire Voice] connecting");

    return new Promise<VoiceStartResult>((resolve) => {
      const timer = setTimeout(() => {
        this.failPending("Realtime connection timed out.", false);
        this.closeSocket(1000);
      }, CONNECT_TIMEOUT_MS);

      this.pending = {
        resolve,
        timer,
      };

      socket.on("message", (data) => {
        this.handleMessage(data.toString());
      });

      socket.on("error", (error) => {
        console.error("[Starfire Voice] socket error:", error.message);

        this.failPending(`Voice connection failed: ${error.message}`, false);
      });

      socket.on("close", (code) => {
        console.log("[Starfire Voice] socket closed:", code);

        this.failPending("Voice connection closed before it was ready.", false);

        if (this.socket === socket) {
          this.socket = null;
        }

        this.emit({
          kind: "closed",
        });
      });
    });
  }

  private failPending(error: string, fatal: boolean): void {
    if (!this.pending) {
      return;
    }

    clearTimeout(this.pending.timer);

    const resolve = this.pending.resolve;

    this.pending = null;

    resolve({
      ok: false,
      error,
      fatal,
    });
  }

  private resolvePending(): void {
    if (!this.pending) {
      return;
    }

    clearTimeout(this.pending.timer);

    const resolve = this.pending.resolve;

    this.pending = null;

    resolve({
      ok: true,
      conn: this.conn,
    });
  }

  private handleMessage(raw: string): void {
    const event = parseServerEvent(raw);

    if (!event) {
      return;
    }

    if (event.kind === "unknown") {
      if (!/input_audio_transcription\.delta$/.test(event.type)) {
        console.debug("[Starfire Voice] ignoring event:", event.type);
      }

      return;
    }

    if (event.kind === "session") {
      if (!this.sessionAnnounced) {
        this.sessionAnnounced = true;

        console.log(
          `[Starfire Voice] session ready (voice=${String(
            event.info.voice ?? "?",
          )}, ` +
            `in=${String(event.info.inputAudioFormat ?? "?")}, ` +
            `out=${String(event.info.outputAudioFormat ?? "?")}, ` +
            `vad=${String(event.info.turnDetection ?? "off")}, ` +
            `tools=${this.registry.names().length})`,
        );

        this.resolvePending();

        this.emit({
          kind: "session",
          info: event.info,
        });

        this.sessionConfigured = true;

        /*
         * Tell the model which tools exist.
         * The manifests are the single source of truth shared
         * with the registry.
         */
        this.send(buildSessionUpdate(this.registry.functionTools()));

        return;
      }

      if (this.sessionConfigured && !this.sessionConfirmedLogged) {
        this.sessionConfirmedLogged = true;

        console.log(
          `[Starfire Voice] session confirmed (in=${String(
            event.info.inputAudioFormat ?? "?",
          )}, ` +
            `out=${String(event.info.outputAudioFormat ?? "?")}, ` +
            `vad=${String(event.info.turnDetection ?? "off")})`,
        );
      }

      return;
    }

    if (event.kind === "response-created") {
      this.responseStartedAt = Date.now();

      this.firstAudioLogged = false;
      this.audioChunks = 0;
      this.audioBytes = 0;

      /*
       * This starts a new model response.
       *
       * pendingSessionEnd intentionally survives here because
       * the response after end_session is the goodbye response.
       */
      this.pendingToolCalls = [];
      this.toolBatchStarted = false;
      this.toolBatchCancelled = false;

      this.emit({
        kind: "response-created",
      });

      return;
    }

    if (event.kind === "audio-delta") {
      const pcm = Buffer.from(event.audio, "base64");

      if (pcm.length > 0) {
        if (this.responseStartedAt > 0 && !this.firstAudioLogged) {
          this.firstAudioLogged = true;

          console.log(
            `[Starfire Voice] ⏱ model first audio: ${
              Date.now() - this.responseStartedAt
            }ms after response.created`,
          );
        }

        this.audioChunks += 1;
        this.audioBytes += pcm.length;

        this.emitAudio(pcm);
      }

      return;
    }

    if (event.kind === "function-call") {
      this.handleFunctionCall(event);
      return;
    }

    if (event.kind === "transcript-delta") {
      this.emit({
        kind: "audio-transcript-delta",
        delta: event.delta,
      });

      return;
    }

    if (event.kind === "input-transcript") {
      this.emit({
        kind: "input-transcript",
        text: event.text,
      });

      return;
    }

    if (event.kind === "speech-started") {
      this.emit({
        kind: "speech-started",
      });

      return;
    }

    if (event.kind === "speech-stopped") {
      this.emit({
        kind: "speech-stopped",
      });

      return;
    }

    if (event.kind === "response-done") {
      if (this.responseStartedAt > 0) {
        console.log(
          `[Starfire Voice] ⏱ response: total ${
            Date.now() - this.responseStartedAt
          }ms, ` +
            `${this.audioChunks} chunks, ${Math.round(
              this.audioBytes / 48,
            )}ms of audio`,
        );

        this.responseStartedAt = 0;
      }

      if (event.usage) {
        console.log("[Starfire Voice] usage:", JSON.stringify(event.usage));
      }

      this.emit({
        kind: "response-done",
        usage: event.usage,
      });

      /*
       * Execute ALL calls from this response through one AgentRunner.run()
       * call so maxCallsPerTurn is enforced correctly.
       */
      if (this.pendingToolCalls.length > 0 && !this.toolBatchStarted) {
        this.startToolBatch();
        return;
      }

      /*
       * end_session succeeded in the previous tool batch.
       *
       * Let Qwen's goodbye audio play briefly, then close the session.
       */
      if (this.pendingSessionEnd) {
        this.pendingSessionEnd = false;

        setTimeout(() => {
          this.emit({
            kind: "session-ended",
          });

          this.closeSocket(1000);
        }, 1500);

        return;
      }

      return;
    }

    if (event.kind === "response-cancelled") {
      this.responseStartedAt = 0;

      /*
       * Do not execute tool calls that were waiting for response.done
       * if the user cancelled the response.
       */
      this.toolBatchCancelled = true;
      this.pendingToolCalls = [];
      this.toolBatchStarted = false;

      this.emit({
        kind: "response-cancelled",
      });

      return;
    }

    if (event.kind === "error") {
      console.error("[Starfire Voice] server error:", event.message);

      this.emit({
        kind: "error",
        message: event.message,
        fatal: event.fatal,
      });

      if (event.fatal) {
        this.failPending(event.message, true);
        this.closeSocket(1000);
      }

      return;
    }
  }

  private handleFunctionCall(event: FunctionCallEvent): void {
    this.pendingToolCalls.push(event);

    this.emit({
      kind: "tool-call",
      name: event.name,
    });

    console.log(
      `[Starfire Voice] 🔧 tool call: ${event.name} ` + `(id=${event.callId})`,
    );
  }

  private startToolBatch(): void {
    if (this.toolBatchStarted) {
      return;
    }

    if (this.toolBatchCancelled) {
      return;
    }

    if (this.pendingToolCalls.length === 0) {
      return;
    }

    this.toolBatchStarted = true;

    const calls = this.pendingToolCalls;

    this.pendingToolCalls = [];

    void this.executeToolBatch(calls);
  }

  private async executeToolBatch(calls: FunctionCallEvent[]): Promise<void> {
    const batchConn = this.conn;

    const runnerCalls = calls.map((call) => ({
      callId: call.callId,
      name: call.name,
      args: this.normalizeToolArgs(call.args),
    }));

    try {
      const results = await this.runner.run(runnerCalls, {
        log: (message) => {
          console.log(`[Starfire Voice] ${message}`);
        },
      });

      /*
       * The session may have been closed/replaced while tools were running.
       * Never send an old batch into a new connection.
       */
      if (
        batchConn !== this.conn ||
        !this.socket ||
        this.socket.readyState !== WebSocket.OPEN ||
        this.toolBatchCancelled
      ) {
        this.toolBatchStarted = false;
        return;
      }

      /*
       * Match results by callId, not array position.
       *
       * AgentRunner may skip malformed calls, so positional matching could
       * accidentally send one tool's result to another tool call.
       */
      const resultsByCallId = new Map(
        results.map((result) => [result.callId, result]),
      );

      for (const call of calls) {
        const result = resultsByCallId.get(call.callId);

        if (!result) {
          continue;
        }

        this.emit({
          kind: "tool-result",
          name: call.name,
          ok: result.ok,
          summary: result.summary,
        });

        console.log(
          `[Starfire Voice] ✅ tool result: ${call.name} ` +
            `(ok=${String(result.ok)})`,
        );

        if (call.name === "end_session" && result.ok) {
          this.pendingSessionEnd = true;
        }

        this.send(buildFunctionCallOutput(result));
      }

      this.toolBatchStarted = false;

      /*
       * Ask Qwen to continue and speak the tool results.
       */
      if (
        batchConn === this.conn &&
        this.socket &&
        this.socket.readyState === WebSocket.OPEN &&
        !this.toolBatchCancelled
      ) {
        this.send(buildResponseCreate());
      }
    } catch (error) {
      this.toolBatchStarted = false;

      console.error("[Starfire Voice] agent batch failed:", error);
    }
  }

  private normalizeToolArgs(args: unknown): Record<string, unknown> {
    if (args && typeof args === "object" && !Array.isArray(args)) {
      return args as Record<string, unknown>;
    }

    return {};
  }

  private handleAudio(audio: unknown): void {
    if (
      typeof audio !== "string" ||
      audio.length === 0 ||
      audio.length > 20000
    ) {
      return;
    }

    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(buildAudioAppend(audio));
    }
  }

  private handleInterrupt(): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(buildResponseCancel());
    }
  }

  private send(payload: string): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(payload);
    }
  }

  private closeSocket(code: number): void {
    const socket = this.socket;

    this.socket = null;

    /*
     * Invalidate any pending tool batch.
     */
    this.pendingToolCalls = [];
    this.toolBatchStarted = false;
    this.toolBatchCancelled = true;
    this.pendingSessionEnd = false;

    if (!socket) {
      return;
    }

    try {
      socket.close(code);
    } catch {
      socket.terminate();
    }

    setTimeout(() => {
      try {
        socket.terminate();
      } catch {
        // already dead
      }
    }, 500).unref();
  }
}
