import type { AgentPorts } from "@starfire/contracts";
import {
  executeDeviceTool,
  STARFIRE_FUNCTION_SPECS,
} from "@starfire/contracts";
import { type BrowserWindow, ipcMain } from "electron";
import WebSocket from "ws";

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

type ToolOutcome = {
  ok: boolean;
  result?: unknown;
  error?: string;
};

/*
 * Owns the EmpirioLabs realtime WebSocket, the API key, and the tool
 * dispatch into Starfire's platform layer.
 *
 * Flow:
 *
 *   realtime function calls
 *        ↓
 *   collect all calls from this response
 *        ↓
 *   executeDeviceTool (same dispatch the Eve tools use)
 *        ↓
 *   real Electron ports
 *        ↓
 *   send every tool result back to the realtime model
 *        ↓
 *   the model speaks the result
 */
export class RealtimeVoiceBridge {
  private socket: WebSocket | null = null;

  private pending: PendingStart | null = null;

  private conn = 0;

  private sessionEndTimer: ReturnType<typeof setTimeout> | null = null;

  private sessionConfigured = false;

  private sessionAnnounced = false;

  private sessionConfirmedLogged = false;

  private responseStartedAt = 0;

  private firstAudioLogged = false;

  private audioChunks = 0;

  private audioBytes = 0;

  /*
   * A single model response can contain multiple function calls.
   * They are collected and executed together once the response
   * completes, so the model speaks about results in one turn.
   */
  private pendingToolCalls: FunctionCallEvent[] = [];

  private toolBatchStarted = false;

  private toolBatchCancelled = false;

  private pendingSessionEnd = false;

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly ports: AgentPorts,
  ) {}

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

    console.log("[Starfire Voice] event=bridge-dispose");

    if (this.sessionEndTimer) {
      clearTimeout(this.sessionEndTimer);

      this.sessionEndTimer = null;
    }

    this.failPending("Voice bridge is shutting down.", false);

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
      console.log(
        `[Starfire Voice] conn=${this.conn} event=start-rejected reason=session-already-active`,
      );

      return Promise.resolve({
        ok: false,
        error: "A voice session is already active.",
        fatal: false,
      });
    }

    this.conn += 1;

    const conn = this.conn;

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

    if (this.sessionEndTimer) {
      clearTimeout(this.sessionEndTimer);

      this.sessionEndTimer = null;
    }

    const endpoint = process.env.EMPIRIOLABS_REALTIME_URL ?? DEFAULT_ENDPOINT;

    const socket = new WebSocket(endpoint, {
      headers: {
        Authorization: `Bearer ${key}`,
      },
    });

    this.socket = socket;

    console.log(`[Starfire Voice] conn=${conn} event=socket-connecting`);

    return new Promise<VoiceStartResult>((resolve) => {
      const timer = setTimeout(() => {
        if (this.socket !== socket) {
          return;
        }

        console.log(
          `[Starfire Voice] conn=${conn} event=connect-timeout ` +
            `timeoutMs=${CONNECT_TIMEOUT_MS}`,
        );

        this.failPending(
          `Realtime connection timed out (conn=${conn}).`,
          false,
        );
        this.closeSocket(1000);
      }, CONNECT_TIMEOUT_MS);

      this.pending = {
        resolve,
        timer,
      };

      /*
       * Every handler verifies socket ownership first: events from a
       * stale socket must NEVER resolve a newer start request, emit
       * events stamped with a newer conn, or touch session state.
       */
      socket.on("message", (data) => {
        if (this.socket !== socket) {
          this.logStaleSocketEvent(conn, "message");

          return;
        }

        this.handleMessage(data.toString());
      });

      socket.on("error", (error) => {
        if (this.socket !== socket) {
          this.logStaleSocketEvent(conn, `error: ${error.message}`);

          return;
        }

        console.error(
          `[Starfire Voice] conn=${conn} event=socket-error error=${error.message}`,
        );

        this.failPending(`Voice connection failed: ${error.message}`, false);
      });

      socket.on("close", (code) => {
        if (this.socket !== socket) {
          this.logStaleSocketEvent(conn, `close code=${code}`);

          return;
        }

        console.log(
          `[Starfire Voice] conn=${conn} event=socket-closed code=${code}`,
        );

        this.socket = null;

        this.failPending(
          `Voice connection closed before it was ready (conn=${conn}).`,
          false,
        );

        this.emit({
          kind: "closed",
        });
      });
    });
  }

  private logStaleSocketEvent(staleConn: number, event: string): void {
    console.log(
      `[Starfire Voice] conn=${staleConn} event=stale-socket-event-ignored ` +
        `detail=${event} activeConn=${this.conn}`,
    );
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
          `[Starfire Voice] conn=${this.conn} event=session-ready ` +
            `voice=${String(event.info.voice ?? "?")}, ` +
            `in=${String(event.info.inputAudioFormat ?? "?")}, ` +
            `out=${String(event.info.outputAudioFormat ?? "?")}, ` +
            `vad=${String(event.info.turnDetection ?? "off")}, ` +
            `tools=${STARFIRE_FUNCTION_SPECS.length}`,
        );

        this.resolvePending();

        this.emit({
          kind: "session",
          info: event.info,
        });

        this.sessionConfigured = true;

        /*
         * Tell the model which Starfire capabilities exist.
         * The specs are the platform contract shared with Eve.
         */
        this.send(buildSessionUpdate(STARFIRE_FUNCTION_SPECS));

        return;
      }

      if (this.sessionConfigured && !this.sessionConfirmedLogged) {
        this.sessionConfirmedLogged = true;

        console.log(
          `[Starfire Voice] conn=${this.conn} event=session-confirmed ` +
            `in=${String(event.info.inputAudioFormat ?? "?")}, ` +
            `out=${String(event.info.outputAudioFormat ?? "?")}, ` +
            `vad=${String(event.info.turnDetection ?? "off")}`,
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
            `[Starfire Voice] conn=${this.conn} event=first-audio ` +
              `latencyMs=${Date.now() - this.responseStartedAt}`,
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
          `[Starfire Voice] conn=${this.conn} event=response-complete ` +
            `durationMs=${Date.now() - this.responseStartedAt} ` +
            `audioChunks=${this.audioChunks} ` +
            `audioMs=${Math.round(this.audioBytes / 48)}`,
        );

        this.responseStartedAt = 0;
      }

      if (event.usage) {
        console.log(
          `[Starfire Voice] conn=${this.conn} event=usage tokens=${JSON.stringify(event.usage)}`,
        );
      }

      this.emit({
        kind: "response-done",
        usage: event.usage,
      });

      /*
       * Execute ALL calls collected from this response in one batch.
       */
      if (this.pendingToolCalls.length > 0 && !this.toolBatchStarted) {
        this.startToolBatch();
        return;
      }

      /*
       * end_session succeeded in the previous tool batch.
       *
       * Let the goodbye audio play briefly, then close the session.
       * The timer is conn-scoped: if this socket is replaced or closed
       * before it fires, it must do nothing.
       */
      if (this.pendingSessionEnd) {
        this.pendingSessionEnd = false;

        const endConn = this.conn;

        this.sessionEndTimer = setTimeout(() => {
          this.sessionEndTimer = null;

          if (this.conn !== endConn) {
            console.log(
              `[Starfire Voice] conn=${endConn} event=stale-session-end-ignored activeConn=${this.conn}`,
            );

            return;
          }

          console.log(`[Starfire Voice] conn=${endConn} event=goodbye-close`);

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
      console.error(
        `[Starfire Voice] conn=${this.conn} event=server-error ` +
          `fatal=${String(event.fatal)} message=${event.message}`,
      );

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
      `[Starfire Voice] conn=${this.conn} event=tool-queued ` +
        `tool=${event.name} callId=${event.callId}`,
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

  private batchStale(batchConn: number): boolean {
    return (
      batchConn !== this.conn ||
      !this.socket ||
      this.socket.readyState !== WebSocket.OPEN ||
      this.toolBatchCancelled
    );
  }

  private async executeToolBatch(calls: FunctionCallEvent[]): Promise<void> {
    const batchConn = this.conn;

    for (const call of calls) {
      if (this.batchStale(batchConn)) {
        console.log(
          `[Starfire Voice] conn=${batchConn} event=tool-batch-aborted ` +
            `tool=${call.name}`,
        );

        this.toolBatchStarted = false;

        return;
      }

      const startedAt = Date.now();

      const outcome = await this.runToolCall(call);

      const durationMs = Date.now() - startedAt;

      this.emit({
        kind: "tool-result",
        name: call.name,
        ok: outcome.ok,
        summary: outcome.ok ? "done" : (outcome.error ?? "failed"),
      });

      console.log(
        `[Starfire Voice] conn=${batchConn} event=tool-complete ` +
          `tool=${call.name} ok=${String(outcome.ok)} durationMs=${durationMs}` +
          (outcome.ok ? "" : ` error=${outcome.error ?? "unknown"}`),
      );

      if (call.name === "end_session" && outcome.ok) {
        this.pendingSessionEnd = true;
      }

      this.send(
        buildFunctionCallOutput({
          callId: call.callId,
          ok: outcome.ok,
          result: outcome.result ?? null,
          error: outcome.error ?? null,
        }),
      );
    }

    this.toolBatchStarted = false;

    /*
     * Ask the model to continue and speak the tool results.
     */
    if (!this.batchStale(batchConn)) {
      this.send(buildResponseCreate());
    }
  }

  private async runToolCall(call: FunctionCallEvent): Promise<ToolOutcome> {
    const args = this.normalizeToolArgs(call.args);

    try {
      const result = await this.execute(call.name, args);

      return {
        ok: true,
        result,
      };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "That didn't work right now.",
      };
    }
  }

  private async execute(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    /*
     * Everything goes through the single shared Starfire capability
     * dispatch — the same layer the Eve tools use. Conversation-local
     * capabilities (current_date_time, end_session), clipboard
     * actions, and window action synonyms are handled there.
     */
    return executeDeviceTool(this.ports, name, args);
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
     * Invalidate any pending tool batch and goodbye close.
     */
    this.pendingToolCalls = [];
    this.toolBatchStarted = false;
    this.toolBatchCancelled = true;
    this.pendingSessionEnd = false;

    if (this.sessionEndTimer) {
      clearTimeout(this.sessionEndTimer);

      this.sessionEndTimer = null;
    }

    if (!socket) {
      return;
    }

    console.log(
      `[Starfire Voice] conn=${this.conn} event=socket-close-requested code=${code}`,
    );

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
