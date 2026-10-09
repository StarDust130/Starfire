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
const CONNECT_TIMEOUT_MS = 10_000;
const CANCEL_TIMEOUT_MS = 1_500;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 30_000;

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

/**
 * Owns one realtime connection.
 *
 * warmUp() connects before the user activates voice.
 * start() activates voice while reusing a configured connection.
 * stop() deactivates voice but keeps a healthy connection.
 * dispose() closes everything during application shutdown.
 *
 * The microphone stays in the renderer/controller. This bridge never
 * opens the microphone and rejects audio unless voice is active.
 */
export class RealtimeVoiceBridge {
  private socket: WebSocket | null = null;
  private pending: PendingStart | null = null;
  private connectionPromise: Promise<VoiceStartResult> | null = null;
  private conn = 0;

  private active = false;
  private disposed = false;
  private activationId = 0;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private cancellationTimer: ReturnType<typeof setTimeout> | null = null;
  private awaitingCancellation = false;
  private cancellationResolvers: Array<() => void> = [];

  private sessionEndTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionConfigured = false;
  private sessionAnnounced = false;
  private sessionConfirmedLogged = false;
  private responseInFlight = false;
  private responseStartedAt = 0;
  private firstAudioLogged = false;
  private audioChunks = 0;
  private audioBytes = 0;

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

    // Stop the conversation, not the warm provider connection.
    ipcMain.handle("starfire-voice:stop", () => {
      this.deactivate();
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

  /** Establish and configure the realtime connection during app startup. */
  async warmUp(): Promise<void> {
    if (this.disposed) return;

    const result = await this.ensureConnected();

    if (result.ok) {
      console.log(`[Starfire Voice] conn=${result.conn} event=warm-ready`);
      return;
    }

    console.warn(`[Starfire Voice] event=warm-up-failed error=${result.error}`);

    if (!result.fatal) {
      this.scheduleReconnect();
    }
  }

  /** Hard shutdown. Only the Electron app lifecycle should call this. */
  async dispose(): Promise<void> {
    if (this.disposed) return;

    this.disposed = true;
    this.active = false;
    this.activationId += 1;

    ipcMain.removeHandler("starfire-voice:start");
    ipcMain.removeHandler("starfire-voice:stop");
    ipcMain.removeAllListeners("starfire-voice:audio");
    ipcMain.removeAllListeners("starfire-voice:interrupt");
    ipcMain.removeAllListeners("starfire-voice:log");

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    if (this.sessionEndTimer) clearTimeout(this.sessionEndTimer);
    this.sessionEndTimer = null;

    if (this.cancellationTimer) clearTimeout(this.cancellationTimer);
    this.cancellationTimer = null;

    this.failPending("Voice bridge is shutting down.", false);
    this.settleCancellation();
    this.closeSocket(1000);

    console.log("[Starfire Voice] event=bridge-dispose");
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

  /**
   * IMPORTANT: do not make this method async.
   *
   * With a warm socket, startAfterQuiescence() reaches ensureConnected()
   * immediately instead of yielding before the connection check.
   */
  private handleStart(): Promise<VoiceStartResult> {
    if (this.disposed) {
      return Promise.resolve({
        ok: false,
        error: "Voice bridge is shutting down.",
        fatal: false,
      });
    }

    if (this.awaitingCancellation) {
      return this.waitForQuiescence().then(() => this.startAfterQuiescence());
    }

    return this.startAfterQuiescence();
  }

  private async startAfterQuiescence(): Promise<VoiceStartResult> {
    if (this.disposed) {
      return {
        ok: false,
        error: "Voice bridge is shutting down.",
        fatal: false,
      };
    }

    const result = await this.ensureConnected();

    if (!result.ok) {
      if (!result.fatal) {
        this.scheduleReconnect();
      }

      return result;
    }

    if (this.disposed) {
      return {
        ok: false,
        error: "Voice bridge is shutting down.",
        fatal: false,
      };
    }

    this.activationId += 1;
    this.active = true;
    this.toolBatchCancelled = false;
    this.pendingToolCalls = [];
    this.toolBatchStarted = false;
    this.pendingSessionEnd = false;

    if (this.sessionEndTimer) {
      clearTimeout(this.sessionEndTimer);
      this.sessionEndTimer = null;
    }

    console.log(`[Starfire Voice] conn=${this.conn} event=voice-activated`);

    return result;
  }

  private ensureConnected(): Promise<VoiceStartResult> {
    if (this.disposed) {
      return Promise.resolve({
        ok: false,
        error: "Voice bridge is shutting down.",
        fatal: false,
      });
    }

    if (
      this.socket &&
      this.socket.readyState === WebSocket.OPEN &&
      this.sessionConfigured
    ) {
      return Promise.resolve({ ok: true, conn: this.conn });
    }

    // All callers share a single connection attempt.
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    // Remove a half-dead socket before creating a replacement.
    if (this.socket) {
      this.closeSocket(1000);
    }

    let promise: Promise<VoiceStartResult>;

    try {
      promise = this.openSocket();
    } catch (error) {
      return Promise.resolve({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Could not open realtime socket.",
        fatal: false,
      });
    }

    this.connectionPromise = promise;

    void promise.then(
      () => {
        if (this.connectionPromise === promise) {
          this.connectionPromise = null;
        }
      },
      () => {
        if (this.connectionPromise === promise) {
          this.connectionPromise = null;
        }
      },
    );

    return promise;
  }

  private openSocket(): Promise<VoiceStartResult> {
    const key = process.env.EMPIRIOLABS_API_KEY;

    if (!key || key.trim().length === 0) {
      return Promise.resolve({
        ok: false,
        error: "EmpirioLabs API key is not configured.",
        fatal: true,
      });
    }

    this.conn += 1;
    const conn = this.conn;

    this.sessionConfigured = false;
    this.sessionAnnounced = false;
    this.sessionConfirmedLogged = false;
    this.responseInFlight = false;
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
      headers: { Authorization: `Bearer ${key}` },
    });

    this.socket = socket;

    console.log(`[Starfire Voice] conn=${conn} event=socket-connecting`);

    return new Promise<VoiceStartResult>((resolve) => {
      const timer = setTimeout(() => {
        if (this.socket !== socket) return;

        console.warn(
          `[Starfire Voice] conn=${conn} event=connect-timeout timeoutMs=${CONNECT_TIMEOUT_MS}`,
        );

        this.failPending(
          `Realtime connection timed out (conn=${conn}).`,
          false,
        );

        this.closeSocket(1000);

        if (!this.active) {
          this.scheduleReconnect();
        }
      }, CONNECT_TIMEOUT_MS);

      this.pending = { resolve, timer };

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
        this.closeSocket(1000);

        if (this.active) {
          this.emit({ kind: "closed" });
        } else {
          this.scheduleReconnect();
        }
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
        this.sessionConfigured = false;
        this.sessionAnnounced = false;
        this.sessionConfirmedLogged = false;
        this.responseInFlight = false;

        this.failPending(
          `Voice connection closed before it was ready (conn=${conn}).`,
          false,
        );

        this.settleCancellation();

        if (this.active) {
          this.emit({ kind: "closed" });
        } else {
          this.scheduleReconnect();
        }
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.active || this.reconnectTimer) return;

    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** Math.min(this.reconnectAttempt, 6),
    );

    this.reconnectAttempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;

      if (this.disposed || this.active) return;

      void this.warmUp();
    }, delay);

    this.reconnectTimer.unref?.();

    console.log(`[Starfire Voice] event=reconnect-scheduled delayMs=${delay}`);
  }

  private logStaleSocketEvent(staleConn: number, event: string): void {
    console.log(
      `[Starfire Voice] conn=${staleConn} event=stale-socket-event-ignored ` +
        `detail=${event} activeConn=${this.conn}`,
    );
  }

  private failPending(error: string, fatal: boolean): void {
    if (!this.pending) return;

    clearTimeout(this.pending.timer);

    const resolve = this.pending.resolve;

    this.pending = null;

    resolve({ ok: false, error, fatal });
  }

  private resolvePending(): void {
    if (!this.pending) return;

    clearTimeout(this.pending.timer);

    const resolve = this.pending.resolve;

    this.pending = null;
    this.reconnectAttempt = 0;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    resolve({ ok: true, conn: this.conn });
  }

  private handleMessage(raw: string): void {
    const event = parseServerEvent(raw);

    if (!event) return;

    if (event.kind === "unknown") {
      if (!/input_audio_transcription\.delta$/.test(event.type)) {
        console.debug("[Starfire Voice] ignoring event:", event.type);
      }

      return;
    }

    if (event.kind === "session") {
      // Configure the session first. Mark it ready only after the provider
      // acknowledges session.update, not merely after session.created.
      if (!this.sessionAnnounced) {
        this.sessionAnnounced = true;

        console.log(
          `[Starfire Voice] conn=${this.conn} event=session-created ` +
            `model=${String(event.info.model ?? REALTIME_MODEL)}`,
        );

        this.send(buildSessionUpdate(STARFIRE_FUNCTION_SPECS));

        return;
      }

      if (!this.sessionConfigured) {
        this.sessionConfigured = true;
        this.sessionConfirmedLogged = true;

        console.log(
          `[Starfire Voice] conn=${this.conn} event=session-ready ` +
            `voice=${String(event.info.voice ?? "?")}, ` +
            `in=${String(event.info.inputAudioFormat ?? "?")}, ` +
            `out=${String(event.info.outputAudioFormat ?? "?")}, ` +
            `vad=${String(event.info.turnDetection ?? "off")}, ` +
            `tools=${STARFIRE_FUNCTION_SPECS.length}`,
        );

        this.resolvePending();
        this.emit({ kind: "session", info: event.info });

        return;
      }

      if (!this.sessionConfirmedLogged) {
        this.sessionConfirmedLogged = true;
      }

      return;
    }

    if (event.kind === "response-created") {
      this.responseInFlight = true;

      // Never let a late response from an inactive voice session leak audio
      // or tool results into the next activation.
      if (!this.active) {
        this.requestCancellation();
        return;
      }

      this.responseStartedAt = Date.now();
      this.firstAudioLogged = false;
      this.audioChunks = 0;
      this.audioBytes = 0;
      this.pendingToolCalls = [];
      this.toolBatchStarted = false;
      this.toolBatchCancelled = false;

      this.emit({ kind: "response-created" });

      return;
    }

    if (event.kind === "audio-delta") {
      if (!this.active) return;

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
      if (this.active) {
        this.handleFunctionCall(event);
      }

      return;
    }

    if (event.kind === "transcript-delta") {
      if (this.active) {
        this.emit({ kind: "audio-transcript-delta", delta: event.delta });
      }

      return;
    }

    if (event.kind === "input-transcript") {
      if (this.active) {
        this.emit({ kind: "input-transcript", text: event.text });
      }

      return;
    }

    if (event.kind === "speech-started") {
      if (this.active) {
        this.emit({ kind: "speech-started" });
      }

      return;
    }

    if (event.kind === "speech-stopped") {
      if (this.active) {
        this.emit({ kind: "speech-stopped" });
      }

      return;
    }

    if (event.kind === "response-done") {
      this.responseInFlight = false;
      this.settleCancellation();

      if (this.responseStartedAt > 0) {
        console.log(
          `[Starfire Voice] conn=${this.conn} event=response-complete ` +
            `durationMs=${Date.now() - this.responseStartedAt} ` +
            `audioChunks=${this.audioChunks} ` +
            `audioMs=${Math.round(this.audioBytes / 48)}`,
        );

        this.responseStartedAt = 0;
      }

      if (!this.active) {
        this.pendingToolCalls = [];
        this.toolBatchStarted = false;
        this.toolBatchCancelled = true;
        return;
      }

      if (event.usage) {
        console.log(
          `[Starfire Voice] conn=${this.conn} event=usage tokens=${JSON.stringify(event.usage)}`,
        );
      }

      this.emit({ kind: "response-done", usage: event.usage });

      if (this.pendingToolCalls.length > 0 && !this.toolBatchStarted) {
        this.startToolBatch();
        return;
      }

      if (this.pendingSessionEnd) {
        this.pendingSessionEnd = false;

        const endConn = this.conn;

        this.sessionEndTimer = setTimeout(() => {
          this.sessionEndTimer = null;

          if (this.conn !== endConn || this.disposed) return;

          console.log(
            `[Starfire Voice] conn=${endConn} event=goodbye-deactivate`,
          );

          this.emit({ kind: "session-ended" });

          // Keep the provider socket ready for the next activation.
          this.deactivate();
        }, 1500);
      }

      return;
    }

    if (event.kind === "response-cancelled") {
      this.responseInFlight = false;
      this.responseStartedAt = 0;
      this.settleCancellation();
      this.pendingToolCalls = [];
      this.toolBatchStarted = false;
      this.toolBatchCancelled = true;

      if (this.active) {
        this.emit({ kind: "response-cancelled" });
      }

      return;
    }

    if (event.kind === "error") {
      console.error(
        `[Starfire Voice] conn=${this.conn} event=server-error ` +
          `fatal=${String(event.fatal)} message=${event.message}`,
      );

      this.emit({ kind: "error", message: event.message, fatal: event.fatal });

      if (event.fatal) {
        this.failPending(event.message, true);
        this.closeSocket(1000);
      }

      return;
    }
  }

  private handleFunctionCall(event: FunctionCallEvent): void {
    this.pendingToolCalls.push(event);

    this.emit({ kind: "tool-call", name: event.name });

    console.log(
      `[Starfire Voice] conn=${this.conn} event=tool-queued ` +
        `tool=${event.name} callId=${event.callId}`,
    );
  }

  private startToolBatch(): void {
    if (
      this.toolBatchStarted ||
      this.toolBatchCancelled ||
      !this.active ||
      this.pendingToolCalls.length === 0
    ) {
      return;
    }

    this.toolBatchStarted = true;

    const calls = this.pendingToolCalls;
    this.pendingToolCalls = [];

    const epoch = this.activationId;

    void this.executeToolBatch(calls, epoch);
  }

  private batchStale(batchConn: number, batchEpoch: number): boolean {
    return (
      batchConn !== this.conn ||
      batchEpoch !== this.activationId ||
      !this.active ||
      !this.socket ||
      this.socket.readyState !== WebSocket.OPEN ||
      this.toolBatchCancelled
    );
  }

  private async executeToolBatch(
    calls: FunctionCallEvent[],
    batchEpoch: number,
  ): Promise<void> {
    const batchConn = this.conn;

    for (const call of calls) {
      if (this.batchStale(batchConn, batchEpoch)) {
        console.log(
          `[Starfire Voice] conn=${batchConn} event=tool-batch-aborted ` +
            `tool=${call.name}`,
        );

        if (batchEpoch === this.activationId) {
          this.toolBatchStarted = false;
        }

        return;
      }

      const startedAt = Date.now();
      const outcome = await this.runToolCall(call);

      if (this.batchStale(batchConn, batchEpoch)) {
        if (batchEpoch === this.activationId) {
          this.toolBatchStarted = false;
        }

        return;
      }

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

    if (batchEpoch === this.activationId) {
      this.toolBatchStarted = false;
    }

    if (!this.batchStale(batchConn, batchEpoch)) {
      this.send(buildResponseCreate());
    }
  }

  private async runToolCall(call: FunctionCallEvent): Promise<ToolOutcome> {
    const args = this.normalizeToolArgs(call.args);

    try {
      return { ok: true, result: await this.execute(call.name, args) };
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
    return executeDeviceTool(this.ports, name, args);
  }

  private normalizeToolArgs(args: unknown): Record<string, unknown> {
    return args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  }

  private handleAudio(audio: unknown): void {
    // Defence in depth: audio is accepted only during an active,
    // configured voice session.
    if (
      !this.active ||
      !this.sessionConfigured ||
      typeof audio !== "string" ||
      audio.length === 0 ||
      audio.length > 20_000
    ) {
      return;
    }

    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(buildAudioAppend(audio));
    }
  }

  private handleInterrupt(): void {
    if (
      !this.active ||
      !this.socket ||
      this.socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    this.socket.send(buildResponseCancel());
  }

  private send(payload: string): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(payload);
    }
  }

  /** Deactivate the conversation but retain a healthy configured socket. */
  private deactivate(): void {
    const wasActive = this.active;

    this.active = false;
    this.activationId += 1;
    this.pendingToolCalls = [];
    this.toolBatchStarted = false;
    this.toolBatchCancelled = true;
    this.pendingSessionEnd = false;

    if (this.sessionEndTimer) {
      clearTimeout(this.sessionEndTimer);
      this.sessionEndTimer = null;
    }

    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      // Clear any partial utterance so it cannot leak into the next turn.
      this.send(JSON.stringify({ type: "input_audio_buffer.clear" }));

      if (this.responseInFlight) {
        this.requestCancellation();
      }
    } else {
      this.responseInFlight = false;
      this.settleCancellation();
    }

    if (wasActive) {
      console.log(`[Starfire Voice] conn=${this.conn} event=voice-deactivated`);
    }
  }

  private requestCancellation(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.responseInFlight = false;
      this.settleCancellation();
      return;
    }

    this.awaitingCancellation = true;
    this.send(buildResponseCancel());

    if (this.cancellationTimer) {
      clearTimeout(this.cancellationTimer);
    }

    this.cancellationTimer = setTimeout(() => {
      this.cancellationTimer = null;

      if (!this.awaitingCancellation || this.disposed) return;

      console.warn(
        "[Starfire Voice] event=cancel-timeout reconnecting-to-clear-state",
      );

      this.closeSocket(1000);
      this.settleCancellation();

      if (!this.active) {
        this.scheduleReconnect();
      }
    }, CANCEL_TIMEOUT_MS);

    this.cancellationTimer.unref?.();
  }

  private waitForQuiescence(): Promise<void> {
    if (!this.awaitingCancellation) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.cancellationResolvers.push(resolve);
    });
  }

  private settleCancellation(): void {
    if (this.cancellationTimer) {
      clearTimeout(this.cancellationTimer);
      this.cancellationTimer = null;
    }

    this.awaitingCancellation = false;

    const resolvers = this.cancellationResolvers.splice(0);

    for (const resolve of resolvers) {
      resolve();
    }
  }

  private closeSocket(code: number): void {
    const socket = this.socket;

    this.socket = null;
    this.sessionConfigured = false;
    this.sessionAnnounced = false;
    this.sessionConfirmedLogged = false;
    this.responseInFlight = false;
    this.responseStartedAt = 0;
    this.pendingToolCalls = [];
    this.toolBatchStarted = false;
    this.toolBatchCancelled = true;
    this.pendingSessionEnd = false;

    this.connectionPromise = null;

    this.failPending("Realtime connection closed.", false);
    this.settleCancellation();

    if (this.sessionEndTimer) {
      clearTimeout(this.sessionEndTimer);
      this.sessionEndTimer = null;
    }

    if (!socket) return;

    console.log(
      `[Starfire Voice] conn=${this.conn} event=socket-close-requested code=${code}`,
    );

    try {
      socket.close(code);
    } catch {
      socket.terminate();
    }

    const terminateTimer = setTimeout(() => {
      try {
        socket.terminate();
      } catch {
        // The socket is already gone.
      }
    }, 500);

    terminateTimer.unref?.();

    if (this.sessionEndTimer) {
      clearTimeout(this.sessionEndTimer);
      this.sessionEndTimer = null;
    }
    if (!socket) return;

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
        // The socket is already gone.
      }
    }, 500).unref();
  }
}
