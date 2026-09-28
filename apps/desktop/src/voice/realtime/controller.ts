import {
  bytesToBase64,
  floatToPcm16,
  LinearResampler,
  mouthFromRms,
  PreRollBuffer,
  SpeechGate,
} from "./audio";

import type { MicPipeline, MicPipelineFactory, MicVariant } from "./microphone";

import {
  transitionVoiceState,
  type VoiceStateName,
  type VoiceTransition,
} from "./state";

export type VoiceStartResult =
  | { ok: true; conn: number }
  | { ok: false; error: string; fatal: boolean };

export type VoiceRendererEvent = {
  conn: number;
} & (
  | { kind: "session"; info: Record<string, unknown> }
  | { kind: "speech-started" }
  | { kind: "speech-stopped" }
  | { kind: "audio-transcript-delta"; delta: string }
  | { kind: "input-transcript"; text: string }
  | { kind: "response-done"; usage: Record<string, number> | null }
  | { kind: "response-cancelled" }
  | { kind: "error"; message: string; fatal: boolean }
  | { kind: "closed" }
);

export type VoiceBridge = {
  start(): Promise<VoiceStartResult>;

  sendAudio(base64Pcm16: string): void;

  interrupt(): void;

  stop(): void;

  onEvent(callback: (event: VoiceRendererEvent) => void): () => void;

  onAudio(callback: (pcm: ArrayBuffer) => void): () => void;
};

export type PlaybackPipeline = {
  warmup(): Promise<void>;

  push(pcm: ArrayBuffer): void;

  clear(): void;

  stop(): Promise<void>;
};

export type PlaybackPipelineFactory = (handlers: {
  onLevel: (rms: number) => void;

  onDiagnostic?: (message: string) => void;

  onDrained?: () => void;
}) => PlaybackPipeline;

export type VoiceControllerDeps = {
  bridge: VoiceBridge | null;

  createMic: MicPipelineFactory;

  createPlayback: PlaybackPipelineFactory;

  onStopWakeEngine: () => Promise<void> | void;

  onStartWakeEngine: () => void;

  onLog?: (message: string) => void;

  getDeviceId?: () => string | undefined;

  micStallTimeoutMs?: number;
};

export type VoiceSnapshot = {
  state: VoiceStateName;

  message: string | null;
};

export const VOICE_INPUT_RATE = 16000;

export const VOICE_TAIL_MS = 1000;

export const VOICE_PRE_ROLL_MS = 220;

export const VOICE_IDLE_AFTER_RESPONSE_MS = 7000;

export const VOICE_IDLE_AFTER_ACTIVATION_MS = 12000;

const CLEANUP_DELAY_MS = 350;

const MIC_STALL_TIMEOUT_MS = 5000;

const FAIL_OPEN_AFTER_MS = 4000;

const SILENT_RMS_THRESHOLD = 1e-6;

const SILENT_CHUNK_LIMIT = 40;

const ECHO_UPLOAD_FLOOR = 0.045;

const ECHO_COOLDOWN_MS = 1500;

const DRAIN_TIMEOUT_MS = 6000;

const MIN_DRAIN_WAIT_MS = 300;

const CONNECT_RETRY_DELAY_MS = 400;

const RECONNECT_DELAY_MS = 300;

const MIC_VARIANTS: MicVariant[] = [
  { processing: true, useDeviceId: true },
  { processing: false, useDeviceId: true },
  { processing: true, useDeviceId: false },
];

function canSendFrom(state: VoiceStateName): boolean {
  return (
    state === "listening" ||
    state === "user-speaking" ||
    state === "thinking" ||
    state === "assistant-speaking"
  );
}

export class VoiceController {
  readonly mouth = { raw: 0 };

  readonly transcript = { user: "", assistant: "" };

  private stateName: VoiceStateName = "idle";

  private message: string | null = null;

  private readonly listeners = new Set<(snapshot: VoiceSnapshot) => void>();

  private gen = 0;

  private conn = -1;

  private disposed = false;

  private cleaningUp = false;

  private stopRequested = false;

  private mic: MicPipeline | null = null;

  private playback: PlaybackPipeline | null = null;

  private resampler: LinearResampler | null = null;

  private captureReady = false;

  private gate = new SpeechGate();

  private preRoll = new PreRollBuffer(1);

  private transmitting = false;

  private localSpeech = false;

  private speechEndedAt = 0;

  private lastChunkAt = 0;

  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;

  private micStallTimer: ReturnType<typeof setTimeout> | null = null;

  private failOpenTimer: ReturnType<typeof setTimeout> | null = null;

  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  private unsubs: Array<() => void> = [];

  private micFrames = 0;

  private gateEverStarted = false;

  private failOpen = false;

  private silentStreak = 0;

  private micAttempt = 0;

  private chosenDeviceId: string | undefined;

  private rebuilding = false;

  private silenceFatal = false;

  private dropStaleAudio = false;

  private staleDropLogged = false;

  private loggedFirstAudio = false;

  private turnEndAt = 0;

  private audioChunks = 0;

  private audioBufferedMs = 0;

  private awaitingDrain = false;

  private echoCooldownUntil = 0;

  private reconnectUsed = false;

  private latencySamples: number[] = [];

  constructor(private readonly deps: VoiceControllerDeps) {}

  getState(): VoiceSnapshot {
    return { state: this.stateName, message: this.message };
  }

  subscribe(listener: (snapshot: VoiceSnapshot) => void): () => void {
    this.listeners.add(listener);

    listener(this.getState());

    return () => {
      this.listeners.delete(listener);
    };
  }

  clearMessage(): void {
    if (this.message !== null) {
      this.message = null;

      this.emitSnapshot();
    }
  }

  private log(message: string): void {
    this.deps.onLog?.(message);
  }

  private emitSnapshot(): void {
    const snapshot = this.getState();

    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private dispatch(event: VoiceTransition): void {
    const prev = this.stateName;

    const next = transitionVoiceState(prev, event);

    if (prev !== next) {
      this.stateName = next;

      this.log(`state ${prev} -> ${next}`);

      this.emitSnapshot();
    }
  }

  private aborted(): boolean {
    return (
      this.disposed ||
      this.stopRequested ||
      this.stateName === "error" ||
      this.stateName === "closing" ||
      this.stateName === "idle"
    );
  }

  private subscribeBridge(): void {
    const bridge = this.deps.bridge;

    if (!bridge) {
      return;
    }

    this.unsubs.push(bridge.onEvent((event) => this.handleBridgeEvent(event)));

    this.unsubs.push(bridge.onAudio((pcm) => this.handlePcm(pcm)));
  }

  private teardownSocketResources(): void {
    for (const unsub of this.unsubs) {
      unsub();
    }

    this.unsubs = [];

    const playback = this.playback;

    this.playback = null;

    void playback?.stop();

    this.mouth.raw = 0;

    this.dropStaleAudio = false;

    this.loggedFirstAudio = false;

    this.awaitingDrain = false;

    if (this.drainTimer) {
      clearTimeout(this.drainTimer);

      this.drainTimer = null;
    }
  }

  private async connectBridge(): Promise<VoiceStartResult> {
    const bridge = this.deps.bridge;

    if (!bridge) {
      return {
        ok: false,
        error: "Voice bridge is unavailable.",
        fatal: true,
      };
    }

    let result = await bridge.start();

    if (!result.ok && !result.fatal) {
      this.log(`connect failed (${result.error}) — retrying once...`);

      await new Promise((resolve) => {
        setTimeout(resolve, CONNECT_RETRY_DELAY_MS);
      });

      if (this.aborted()) {
        return result;
      }

      result = await bridge.start();
    }

    return result;
  }

  async start(source?: string): Promise<void> {
    if (this.disposed || this.stateName !== "idle") {
      this.log(
        `activation ignored (source=${source ?? "?"}, state=${this.stateName})`,
      );

      return;
    }

    if (!this.deps.bridge) {
      this.message = "Voice bridge is unavailable.";

      this.dispatch({ type: "fatal-error" });

      this.cleanup();

      return;
    }

    this.gen += 1;

    this.stopRequested = false;

    this.message = null;

    this.transcript.user = "";

    this.transcript.assistant = "";

    this.dispatch({ type: "start" });

    try {
      await this.deps.onStopWakeEngine();
    } catch (error) {
      console.error("[Starfire Voice] wake engine stop failed:", error);
    }

    if (this.aborted()) {
      return;
    }

    this.preRoll = new PreRollBuffer(
      (VOICE_INPUT_RATE * VOICE_PRE_ROLL_MS) / 1000,
    );

    this.gate = new SpeechGate();

    this.transmitting = false;

    this.localSpeech = false;

    this.lastChunkAt = 0;

    this.micFrames = 0;

    this.gateEverStarted = false;

    this.failOpen = false;

    this.silentStreak = 0;

    this.micAttempt = 0;

    this.silenceFatal = false;

    this.dropStaleAudio = false;

    this.staleDropLogged = false;

    this.loggedFirstAudio = false;

    this.turnEndAt = 0;

    this.audioChunks = 0;

    this.audioBufferedMs = 0;

    this.awaitingDrain = false;

    this.echoCooldownUntil = 0;

    this.reconnectUsed = false;

    this.latencySamples = [];

    this.captureReady = false;

    this.chosenDeviceId = this.deps.getDeviceId?.();

    if (this.chosenDeviceId) {
      this.log(`using wake-engine microphone (id=${this.chosenDeviceId})`);
    } else {
      this.log("no chosen microphone id — using system default");
    }

    let inputRate = VOICE_INPUT_RATE;

    let micFailed = false;

    const mic = this.deps.createMic(
      {
        onChunk: (chunk) => this.handleMicChunk(chunk),

        onDiagnostic: (message) => this.log(message),
      },
      MIC_VARIANTS[this.micAttempt],
      this.chosenDeviceId,
    );

    /*
     * PARALLEL STARTUP: mic, output pipeline, and the websocket all
     * start at once.
     */
    const micPromise = mic.start().then(
      (rate) => {
        inputRate = rate;
      },
      (error) => {
        micFailed = true;

        console.error("[Starfire Voice] microphone failed:", error);
      },
    );

    this.playback = this.deps.createPlayback({
      onLevel: (rms) => {
        this.mouth.raw = mouthFromRms(rms);
      },

      onDiagnostic: (message) => this.log(message),

      onDrained: () => this.handlePlaybackDrained(),
    });

    void this.playback.warmup();

    this.subscribeBridge();

    const connect = await this.connectBridge();

    await micPromise;

    if (this.aborted()) {
      void mic.stop();

      return;
    }

    if (micFailed) {
      void mic.stop();

      this.message = "Microphone is unavailable.";

      this.dispatch({ type: "fatal-error" });

      this.cleanup();

      return;
    }

    if (!connect.ok) {
      void mic.stop();

      this.message = connect.error;

      this.log(`start failed: ${connect.error}`);

      if (connect.fatal) {
        this.dispatch({ type: "fatal-error" });
      } else {
        this.dispatch({ type: "stop" });
      }

      this.cleanup();

      return;
    }

    this.mic = mic;

    this.resampler =
      inputRate === VOICE_INPUT_RATE
        ? null
        : new LinearResampler(inputRate, VOICE_INPUT_RATE);

    this.captureReady = true;

    this.log(
      `capture rate=${inputRate}Hz` +
        (inputRate === VOICE_INPUT_RATE ? "" : " (software resampled to 16k)"),
    );

    this.micStallTimer = setTimeout(() => {
      if (this.disposed || this.micFrames > 0) {
        return;
      }

      this.log("fatal: no microphone frames received");

      this.message = "Microphone capture stalled.";

      this.dispatch({ type: "fatal-error" });

      this.cleanup();
    }, this.deps.micStallTimeoutMs ?? MIC_STALL_TIMEOUT_MS);

    this.dispatch({ type: "mic-ready" });

    this.conn = connect.conn;

    this.dispatch({ type: "session-ready" });

    this.scheduleIdle(VOICE_IDLE_AFTER_ACTIVATION_MS);

    this.failOpenTimer = setTimeout(() => {
      if (this.disposed || this.failOpen || this.gateEverStarted) {
        return;
      }

      if (this.micFrames < 10) {
        return;
      }

      this.failOpen = true;

      this.log(
        "local gate never fired — fail-open: streaming continuously (server VAD authoritative)",
      );
    }, FAIL_OPEN_AFTER_MS);

    this.log("session ready (listening)");
  }

  stop(reason = "stop"): void {
    if (
      this.disposed ||
      this.stateName === "idle" ||
      this.stateName === "closing" ||
      this.stateName === "error"
    ) {
      return;
    }

    this.stopRequested = true;

    this.log(`closing (${reason})`);

    this.dispatch({
      type: reason === "idle-timeout" ? "idle-timeout" : "stop",
    });

    this.cleanup();
  }

  dispose(): void {
    this.disposed = true;

    this.stop("dispose");

    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);

      this.cleanupTimer = null;
    }

    if (this.drainTimer) {
      clearTimeout(this.drainTimer);

      this.drainTimer = null;
    }

    this.listeners.clear();
  }

  private scheduleIdle(ms: number): void {
    this.clearIdleTimer();

    this.idleTimer = setTimeout(() => {
      this.stop("idle-timeout");
    }, ms);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);

      this.idleTimer = null;
    }
  }

  private clearMicStallTimer(): void {
    if (this.micStallTimer) {
      clearTimeout(this.micStallTimer);

      this.micStallTimer = null;
    }
  }

  private flushPreRoll(): void {
    for (const b64 of this.preRoll.flush()) {
      if (canSendFrom(this.stateName) && !this.disposed) {
        this.deps.bridge?.sendAudio(b64);
      }
    }
  }

  private async rebuildMic(): Promise<void> {
    if (this.rebuilding || this.disposed) {
      return;
    }

    this.rebuilding = true;

    const old = this.mic;

    this.mic = null;

    void old?.stop();

    const variant = MIC_VARIANTS[this.micAttempt];

    try {
      const mic = this.deps.createMic(
        {
          onChunk: (chunk) => this.handleMicChunk(chunk),

          onDiagnostic: (message) => this.log(message),
        },
        variant,
        this.chosenDeviceId,
      );

      const rate = await mic.start();

      if (this.disposed) {
        void mic.stop();

        return;
      }

      this.mic = mic;

      this.resampler =
        rate === VOICE_INPUT_RATE
          ? null
          : new LinearResampler(rate, VOICE_INPUT_RATE);

      this.silentStreak = 0;

      this.log(
        `mic attempt ${this.micAttempt + 1}/${MIC_VARIANTS.length} opened ` +
          `(processing=${variant.processing ? "on" : "off"}, ` +
          `source=${variant.useDeviceId && this.chosenDeviceId ? "chosen device" : "system default"})`,
      );
    } catch {
      this.log("microphone rebuild failed");
    } finally {
      this.rebuilding = false;
    }
  }

  private handleMicChunk(chunk: { samples: Float32Array; rms: number }): void {
    if (this.disposed || !this.captureReady) {
      return;
    }

    if (this.micFrames === 0) {
      this.clearMicStallTimer();
    }

    this.micFrames += 1;

    if (this.micFrames === 10) {
      this.log(
        `mic frames flowing (rms=${chunk.rms.toFixed(4)}, frames=${this.micFrames})`,
      );
    }

    if (chunk.rms < SILENT_RMS_THRESHOLD) {
      this.silentStreak += 1;
    } else {
      this.silentStreak = 0;
    }

    if (
      this.silentStreak >= SILENT_CHUNK_LIMIT &&
      !this.rebuilding &&
      canSendFrom(this.stateName)
    ) {
      if (this.micAttempt < MIC_VARIANTS.length - 1) {
        this.micAttempt += 1;

        this.log(
          `microphone silent — switching capture configuration ` +
            `(attempt ${this.micAttempt + 1}/${MIC_VARIANTS.length})`,
        );

        void this.rebuildMic();

        return;
      }

      if (!this.silenceFatal) {
        this.silenceFatal = true;

        this.message = "Microphone is not delivering audio.";

        this.log(
          "fatal: silence persisted across all capture configurations " +
            "(check the system input device in KDE audio settings)",
        );

        this.dispatch({ type: "fatal-error" });

        this.cleanup();

        return;
      }
    }

    const now = Date.now();

    const dt =
      this.lastChunkAt > 0
        ? Math.min(Math.max(now - this.lastChunkAt, 1), 100)
        : 20;

    this.lastChunkAt = now;

    const resampled = this.resampler
      ? this.resampler.process(chunk.samples)
      : chunk.samples;

    const b64 = bytesToBase64(floatToPcm16(resampled));

    if (!canSendFrom(this.stateName)) {
      this.preRoll.push(b64, resampled.length);

      return;
    }

    /*
     * ---------------------------------------------------
     * ECHO GUARD
     * ---------------------------------------------------
     * The speech gate must ONLY ever see audio we would actually
     * upload. Her speaker echo must never latch it — a latched gate
     * swallows the `started` edge of the user's real next sentence,
     * which clipped words and broke turn starts.
     */
    if (this.stateName === "assistant-speaking") {
      if (chunk.rms >= ECHO_UPLOAD_FLOOR) {
        /*
         * Real user speech over her voice: stream it; the server VAD
         * performs the authoritative interruption.
         */
        this.clearIdleTimer();

        this.deps.bridge?.sendAudio(b64);
      } else {
        this.gate = new SpeechGate();
      }

      return;
    }

    if (now < this.echoCooldownUntil) {
      if (chunk.rms >= ECHO_UPLOAD_FLOOR) {
        if (!this.localSpeech) {
          this.log("user speaking (local)");

          this.localSpeech = true;

          this.dispatch({ type: "local-speech-start" });
        }

        this.clearIdleTimer();

        this.gate = new SpeechGate();

        this.deps.bridge?.sendAudio(b64);
      } else {
        this.gate = new SpeechGate();
      }

      return;
    }

    /*
     * Normal path: the gate sees clean, non-echo audio.
     */
    const gate = this.gate.update(chunk.rms, dt);

    if (gate.started) {
      this.gateEverStarted = true;

      this.clearIdleTimer();
    }

    if (gate.started) {
      this.log("user speaking (local)");

      this.localSpeech = true;

      this.dispatch({ type: "local-speech-start" });

      this.flushPreRoll();

      this.transmitting = true;

      this.deps.bridge?.sendAudio(b64);

      return;
    }

    if (this.localSpeech) {
      this.deps.bridge?.sendAudio(b64);

      if (gate.ended) {
        this.localSpeech = false;

        this.speechEndedAt = now;
      }

      return;
    }

    if (this.transmitting) {
      if (now - this.speechEndedAt <= VOICE_TAIL_MS) {
        this.deps.bridge?.sendAudio(b64);

        return;
      }

      this.transmitting = false;

      this.dispatch({ type: "local-speech-end" });
    }

    if (this.failOpen) {
      this.deps.bridge?.sendAudio(b64);

      return;
    }

    this.preRoll.push(b64, resampled.length);
  }

  private handleBridgeEvent(event: VoiceRendererEvent): void {
    if (event.conn !== this.conn || this.disposed) {
      return;
    }

    switch (event.kind) {
      case "speech-started": {
        this.clearIdleTimer();

        this.transcript.user = "";

        this.transcript.assistant = "";

        if (this.stateName === "assistant-speaking") {
          this.playback?.clear();

          this.mouth.raw = 0;

          this.dropStaleAudio = true;

          this.staleDropLogged = false;

          this.log("assistant interrupted (server VAD)");
        }

        if (!this.transmitting) {
          this.flushPreRoll();

          this.transmitting = true;
        }

        this.turnEndAt = 0;

        this.log("user speaking (server)");

        this.dispatch({ type: "server-speech-start" });

        break;
      }

      case "speech-stopped": {
        this.log("user turn ended");

        this.transmitting = false;

        this.localSpeech = false;

        this.dropStaleAudio = false;

        this.turnEndAt = Date.now();

        this.dispatch({ type: "server-speech-end" });

        break;
      }

      case "audio-transcript-delta": {
        this.transcript.assistant += event.delta;

        break;
      }

      case "input-transcript": {
        this.transcript.user = event.text;

        this.log(`you said: ${event.text}`);

        break;
      }

      case "response-done": {
        const buffered = this.audioBufferedMs;

        if (this.audioChunks === 0) {
          this.log(
            "model returned an empty response (no audio) — likely a garbled turn; just speak again",
          );
        } else {
          this.log(
            `⏱ assistant buffered: ${this.audioChunks} chunks, ` +
              `${Math.round(buffered)}ms of audio`,
          );
        }

        this.audioChunks = 0;

        this.audioBufferedMs = 0;

        this.dropStaleAudio = false;

        if (
          buffered > MIN_DRAIN_WAIT_MS &&
          this.stateName === "assistant-speaking"
        ) {
          this.awaitingDrain = true;

          this.log("response complete — waiting for playback to drain");

          if (this.drainTimer) {
            clearTimeout(this.drainTimer);
          }

          this.drainTimer = setTimeout(() => {
            this.finishResponseDone();
          }, DRAIN_TIMEOUT_MS);
        } else {
          this.finishResponseDone();
        }

        break;
      }

      case "response-cancelled": {
        this.log("response cancelled by server");

        this.dropStaleAudio = false;

        if (this.stateName === "assistant-speaking") {
          this.dispatch({ type: "interrupted" });
        }

        break;
      }

      case "error": {
        if (event.fatal) {
          this.message = event.message.startsWith("Empirio")
            ? event.message
            : "EmpirioLabs authentication failed.";

          this.log(`fatal: ${this.message}`);

          this.dispatch({ type: "fatal-error" });

          this.cleanup();
        } else {
          console.error("[Starfire Voice] server error:", event.message);
        }

        break;
      }

      case "closed": {
        if (this.disposed || this.stopRequested) {
          break;
        }

        if (canSendFrom(this.stateName) || this.stateName === "starting") {
          if (!this.reconnectUsed) {
            this.reconnectUsed = true;

            this.log("connection lost — reconnecting automatically (1/1)");

            void this.reconnect();
          } else {
            this.message = "Voice connection closed.";

            this.log("connection lost (reconnect already used)");

            this.dispatch({ type: "stop" });

            this.cleanup();
          }
        }

        break;
      }

      default:
        break;
    }
  }

  private async reconnect(): Promise<void> {
    this.teardownSocketResources();

    await new Promise((resolve) => {
      setTimeout(resolve, RECONNECT_DELAY_MS);
    });

    if (this.disposed || this.stopRequested) {
      this.dispatch({ type: "stop" });

      this.cleanup();

      return;
    }

    const connect = await this.connectBridge();

    if (this.disposed || this.stopRequested) {
      this.dispatch({ type: "stop" });

      this.cleanup();

      return;
    }

    if (!connect.ok) {
      this.message = connect.error;

      this.log(`reconnect failed: ${connect.error}`);

      this.dispatch({ type: "stop" });

      this.cleanup();

      return;
    }

    this.playback = this.deps.createPlayback({
      onLevel: (rms) => {
        this.mouth.raw = mouthFromRms(rms);
      },

      onDiagnostic: (message) => this.log(message),

      onDrained: () => this.handlePlaybackDrained(),
    });

    void this.playback.warmup();

    this.subscribeBridge();

    this.conn = connect.conn;

    this.audioChunks = 0;

    this.audioBufferedMs = 0;

    this.turnEndAt = 0;

    this.dispatch({ type: "session-ready" });

    this.scheduleIdle(VOICE_IDLE_AFTER_ACTIVATION_MS);

    this.log("reconnected — session ready (listening)");
  }

  private handlePlaybackDrained(): void {
    this.mouth.raw = 0;

    if (this.awaitingDrain) {
      this.log("playback drained");

      this.finishResponseDone();
    }
  }

  private finishResponseDone(): void {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);

      this.drainTimer = null;
    }

    this.awaitingDrain = false;

    this.echoCooldownUntil = Date.now() + ECHO_COOLDOWN_MS;

    this.gate = new SpeechGate();

    this.dispatch({ type: "response-done" });

    this.scheduleIdle(VOICE_IDLE_AFTER_RESPONSE_MS);
  }

  private handlePcm(pcm: ArrayBuffer): void {
    if (
      this.disposed ||
      this.stateName === "closing" ||
      this.stateName === "idle"
    ) {
      return;
    }

    if (this.dropStaleAudio) {
      if (!this.staleDropLogged) {
        this.staleDropLogged = true;

        this.log("dropping stale audio from the interrupted response");
      }

      return;
    }

    if (!this.loggedFirstAudio) {
      this.loggedFirstAudio = true;

      this.log("playback: assistant audio streaming (24 kHz PCM)");

      if (this.turnEndAt > 0) {
        const sample = Date.now() - this.turnEndAt;

        this.latencySamples.push(sample);

        this.log(`⏱ turn -> first audio: ${sample}ms`);
      }
    }

    this.audioChunks += 1;

    this.audioBufferedMs += pcm.byteLength / 2 / 24;

    this.dispatch({ type: "response-audio" });

    this.playback?.push(pcm);
  }

  private logLatencySummary(): void {
    if (this.latencySamples.length === 0) {
      return;
    }

    const sorted = [...this.latencySamples].sort((a, b) => a - b);

    const pick = (q: number): number =>
      sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

    this.log(
      `⏱ latency summary (n=${sorted.length}): ` +
        `p50=${pick(0.5)}ms, p95=${pick(0.95)}ms, best=${sorted[0]}ms, worst=${sorted[sorted.length - 1]}ms`,
    );
  }

  private cleanup(): void {
    if (this.cleaningUp) {
      return;
    }

    this.cleaningUp = true;

    this.clearIdleTimer();

    this.clearMicStallTimer();

    if (this.failOpenTimer) {
      clearTimeout(this.failOpenTimer);

      this.failOpenTimer = null;
    }

    if (this.drainTimer) {
      clearTimeout(this.drainTimer);

      this.drainTimer = null;
    }

    this.awaitingDrain = false;

    this.logLatencySummary();

    const gen = this.gen;

    for (const unsub of this.unsubs) {
      unsub();
    }

    this.unsubs = [];

    const playback = this.playback;

    this.playback = null;

    void playback?.stop();

    const mic = this.mic;

    this.mic = null;

    void mic?.stop();

    this.deps.bridge?.stop();

    this.mouth.raw = 0;

    this.transmitting = false;

    this.localSpeech = false;

    this.resampler = null;

    this.captureReady = false;

    this.preRoll.clear();

    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
    }

    this.cleanupTimer = setTimeout(() => {
      this.cleaningUp = false;

      if (this.disposed || gen !== this.gen) {
        return;
      }

      try {
        this.deps.onStartWakeEngine();
      } catch (error) {
        console.error("[Starfire Voice] wake engine restart failed:", error);
      }

      this.dispatch({ type: "cleanup-complete" });
    }, CLEANUP_DELAY_MS);
  }
}
