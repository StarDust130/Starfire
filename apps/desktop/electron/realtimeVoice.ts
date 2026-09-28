import { ipcMain, type BrowserWindow } from "electron";

import WebSocket from "ws";

import {
  buildAudioAppend,
  buildResponseCancel,
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

/*
 * Owns the EmpirioLabs realtime WebSocket and the API key.
 * The renderer only ever sees validated events and raw PCM audio.
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

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

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

    const endpoint = process.env.EMPIRIOLABS_REALTIME_URL ?? DEFAULT_ENDPOINT;

    const socket = new WebSocket(endpoint, {
      headers: { Authorization: `Bearer ${key}` },
    });

    this.socket = socket;

    console.log("[Starfire Voice] connecting");

    return new Promise<VoiceStartResult>((resolve) => {
      const timer = setTimeout(() => {
        this.failPending("Realtime connection timed out.", false);

        this.closeSocket(1000);
      }, CONNECT_TIMEOUT_MS);

      this.pending = { resolve, timer };

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

        this.emit({ kind: "closed" });
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

    resolve({ ok: false, error, fatal });
  }

  private resolvePending(): void {
    if (!this.pending) {
      return;
    }

    clearTimeout(this.pending.timer);

    const resolve = this.pending.resolve;

    this.pending = null;

    resolve({ ok: true, conn: this.conn });
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
          `[Starfire Voice] session ready (voice=${String(event.info.voice ?? "?")}, ` +
            `in=${String(event.info.inputAudioFormat ?? "?")}, ` +
            `out=${String(event.info.outputAudioFormat ?? "?")}, ` +
            `vad=${String(event.info.turnDetection ?? "off")})`,
        );

        this.resolvePending();

        this.emit({ kind: "session", info: event.info });

        this.sessionConfigured = true;

        this.send(buildSessionUpdate());

        return;
      }

      if (this.sessionConfigured && !this.sessionConfirmedLogged) {
        this.sessionConfirmedLogged = true;

        console.log(
          `[Starfire Voice] session confirmed (in=${String(event.info.inputAudioFormat ?? "?")}, ` +
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
       * Forwarded so the renderer knows when a fresh response begins
       * after an interrupt — stale audio is dropped until this point.
       */
      this.emit({ kind: "response-created" });

      return;
    }

    if (event.kind === "audio-delta") {
      const pcm = Buffer.from(event.audio, "base64");

      if (pcm.length > 0) {
        if (this.responseStartedAt > 0 && !this.firstAudioLogged) {
          this.firstAudioLogged = true;

          console.log(
            `[Starfire Voice] ⏱ model first audio: ${Date.now() - this.responseStartedAt}ms after response.created`,
          );
        }

        this.audioChunks += 1;

        this.audioBytes += pcm.length;

        this.emitAudio(pcm);
      }

      return;
    }

    if (event.kind === "transcript-delta") {
      this.emit({ kind: "audio-transcript-delta", delta: event.delta });

      return;
    }

    if (event.kind === "input-transcript") {
      this.emit({ kind: "input-transcript", text: event.text });

      return;
    }

    if (event.kind === "speech-started") {
      this.emit({ kind: "speech-started" });

      return;
    }

    if (event.kind === "speech-stopped") {
      this.emit({ kind: "speech-stopped" });

      return;
    }

    if (event.kind === "response-done") {
      if (this.responseStartedAt > 0) {
        console.log(
          `[Starfire Voice] ⏱ response: total ${Date.now() - this.responseStartedAt}ms, ` +
            `${this.audioChunks} chunks, ${Math.round(this.audioBytes / 48)}ms of audio`,
        );

        this.responseStartedAt = 0;
      }

      if (event.usage) {
        console.log("[Starfire Voice] usage:", JSON.stringify(event.usage));
      }

      this.emit({ kind: "response-done", usage: event.usage });

      return;
    }

    if (event.kind === "response-cancelled") {
      this.responseStartedAt = 0;

      this.emit({ kind: "response-cancelled" });

      return;
    }

    if (event.kind === "error") {
      console.error("[Starfire Voice] server error:", event.message);

      this.emit({ kind: "error", message: event.message, fatal: event.fatal });

      if (event.fatal) {
        this.failPending(event.message, true);

        this.closeSocket(1000);
      }

      return;
    }
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
