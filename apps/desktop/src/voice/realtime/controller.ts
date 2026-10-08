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
  | { kind: "response-created" }
  | { kind: "tool-call"; name: string }
  | { kind: "tool-result"; ok: boolean; summary: string }
  | { kind: "tool-end" }
  | { kind: "session-ended" }
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

  onToolEvent?: (event: {
    kind: "tool-call" | "tool-result" | "tool-end";

    name?: string;
  }) => void;

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

const LOCAL_BARGE_FLOOR = 0.09;

const LOCAL_BARGE_FRAMES = 18;

const TOOL_ROUND_IDLE_MS = 15000;

const GOODBYE_GRACE_MS = 12000;

const STALE_DROP_WINDOW_MS = 3000;

const MAX_RECONNECTS_PER_SESSION = 20;

/*
 * Goodbye keywords in the user's transcribed speech. When detected,
 * the session closes after her farewell response finishes — no
 * reliance on the model calling a tool.
 */
const GOODBYE_PATTERN =
  /\b(bye|goodbye|good bye|see you|see ya|that'?s all|talk later|later bye|अलविदा|फिर मिलेंगे|बाय)\b/i;

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

  private goodbyeTimer: ReturnType<typeof setTimeout> | null = null;

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

  private interruptedResponse = false;

  private interruptedResponseAt = 0;

  private staleDropLogged = false;

  private loudStreak = 0;

  private loggedFirstAudio = false;

  private turnEndAt = 0;

  /*
   * Recent-activity timestamps for the idle watchdog. The idle timer
   * must never close a session that is actively using tools, receiving
   * a model response, playing audio, or hearing the user.
   */
  private lastAudioAt = 0;

  private lastToolEventAt = 0;

  private lastSentAt = 0;

  private lastLevelAt = 0;

  private audioChunks = 0;

  private audioBufferedMs = 0;

  private awaitingDrain = false;

  private echoCooldownUntil = 0;

  private reconnectsUsed = 0;

  private latencySamples: number[] = [];

  private toolRoundActive = false;

  private goodbyeActive = false;

  private goodbyeDetected = false;

  private outputLevel = 0;

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

  /*
   * Structured lifecycle log: connection + state + event, so terminal
   * lines can be correlated across the renderer and the main process.
   */
  private logEvent(message: string): void {
    this.log(`conn=${this.conn} state=${this.stateName} ${message}`);
  }

  private sendAudioChunk(b64: string): void {
    this.lastSentAt = Date.now();

    this.deps.bridge?.sendAudio(b64);
  }

  private clearGoodbyeTimer(): void {
    if (this.goodbyeTimer) {
      clearTimeout(this.goodbyeTimer);

      this.goodbyeTimer = null;

      this.log("event=goodbye-timer-cleared");
    }
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

      this.logEvent(`event=state-change from=${prev} to=${next}`);

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

    this.outputLevel = 0;

    this.loggedFirstAudio = false;

    this.cancelDrainWait();
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
      this.logEvent(`event=connect-retry error=${result.error}`);

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
        `conn=${this.conn} event=activation-ignored ` +
          `source=${source ?? "?"} state=${this.stateName}`,
      );

      return;
    }

    this.logEvent(`event=activation source=${source ?? "?"}`);

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

    this.goodbyeActive = false;

    this.goodbyeDetected = false;

    this.reconnectsUsed = 0;

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

    this.interruptedResponse = false;

    this.interruptedResponseAt = 0;

    this.staleDropLogged = false;

    this.loudStreak = 0;

    this.loggedFirstAudio = false;

    this.turnEndAt = 0;

    this.audioChunks = 0;

    this.audioBufferedMs = 0;

    this.awaitingDrain = false;

    this.echoCooldownUntil = 0;

    this.latencySamples = [];

    this.lastAudioAt = 0;

    this.lastToolEventAt = 0;

    this.lastSentAt = 0;

    this.lastLevelAt = 0;

    this.captureReady = false;

    this.toolRoundActive = false;

    this.outputLevel = 0;

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
        this.outputLevel = rms;

        this.lastLevelAt = Date.now();

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

      /*
       * A start that resolved while we were already stopping may have
       * opened a socket AFTER the last cleanup's bridge.stop() — close
       * it so no zombie connection survives.
       */
      this.deps.bridge?.stop();

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

      this.logEvent(`event=start-failed error=${connect.error}`);

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
      `conn=${connect.conn} event=capture-open rate=${inputRate}Hz` +
        (inputRate === VOICE_INPUT_RATE ? "" : " (resampled to 16k)"),
    );

    this.micStallTimer = setTimeout(() => {
      if (this.disposed || this.micFrames > 0) {
        return;
      }

      this.logEvent("event=fatal-error reason=no microphone frames received");

      this.message = "Microphone capture stalled.";

      this.dispatch({ type: "fatal-error" });

      this.cleanup();
    }, this.deps.micStallTimeoutMs ?? MIC_STALL_TIMEOUT_MS);

    this.dispatch({ type: "mic-ready" });

    this.conn = connect.conn;

    this.dispatch({ type: "session-ready" });

    this.scheduleIdle(VOICE_IDLE_AFTER_ACTIVATION_MS, "activation");

    this.failOpenTimer = setTimeout(() => {
      if (this.disposed || this.failOpen || this.gateEverStarted) {
        return;
      }

      if (this.micFrames < 10) {
        return;
      }

      this.failOpen = true;

      this.logEvent(
        "event=fail-open reason=local gate never fired note=server VAD authoritative",
      );
    }, FAIL_OPEN_AFTER_MS);

    this.logEvent("event=session-ready");
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

    this.logEvent(`event=stop reason=${reason}`);

    this.dispatch({
      type: reason === "idle-timeout" ? "idle-timeout" : "stop",
    });

    this.cleanup();
  }

  dispose(): void {
    if (this.disposed && !this.cleaningUp) {
      return;
    }

    this.disposed = true;

    this.logEvent("event=dispose");

    /*
     * stop() early-returns once disposed, so dispose must perform the
     * full teardown itself — microphone, playback, socket bridge,
     * timers, and listeners — no matter which state we are in.
     */
    this.clearIdleTimer("dispose");

    this.clearMicStallTimer();

    this.clearGoodbyeTimer();

    this.cancelDrainWait();

    if (this.failOpenTimer) {
      clearTimeout(this.failOpenTimer);

      this.failOpenTimer = null;
    }

    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);

      this.cleanupTimer = null;
    }

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

    this.outputLevel = 0;

    this.transmitting = false;

    this.localSpeech = false;

    this.resampler = null;

    this.captureReady = false;

    this.toolRoundActive = false;

    this.cleaningUp = false;

    this.preRoll.clear();

    this.listeners.clear();
  }

  private scheduleIdle(ms: number, reason: string): void {
    this.clearIdleTimer("replaced");

    this.idleTimer = setTimeout(() => {
      this.handleIdleTimerFired(ms, reason);
    }, ms);

    this.log(`event=idle-timer-set ms=${ms} reason=${reason}`);
  }

  /*
   * The idle watchdog may only close a session that is TRULY idle.
   * When it fires while Starfire is busy (tool round, model response,
   * assistant audio, playback drain, user speaking), it postpones
   * itself instead — a stale timer must never kill an active session.
   */
  private handleIdleTimerFired(ms: number, reason: string): void {
    this.idleTimer = null;

    const now = Date.now();

    const busy: string[] = [];

    if (
      this.toolRoundActive &&
      now - this.lastToolEventAt < TOOL_ROUND_IDLE_MS
    ) {
      busy.push("tool-round-active");
    }

    if (this.awaitingDrain) {
      busy.push("awaiting-playback-drain");
    }

    /*
     * She is audible either while audio chunks are still arriving or
     * while the playback pipeline is actively playing out its queue
     * (the worklet reports levels ~every 16ms while playing).
     */
    if (
      this.stateName === "assistant-speaking" &&
      (now - this.lastAudioAt < DRAIN_TIMEOUT_MS ||
        (this.outputLevel > 0 && now - this.lastLevelAt < DRAIN_TIMEOUT_MS))
    ) {
      busy.push("assistant-audio-active");
    }

    if (this.stateName === "user-speaking" && now - this.lastSentAt < 10000) {
      busy.push("user-speaking");
    }

    /*
     * While the model is generating her reply the watchdog must not
     * disconnect — but the protection is bounded to the tool-round
     * stall budget so a permanently stuck session still recovers.
     */
    if (
      this.stateName === "thinking" &&
      now - Math.max(this.turnEndAt, this.lastToolEventAt, this.lastAudioAt) <
        TOOL_ROUND_IDLE_MS
    ) {
      busy.push("thinking");
    }

    if (busy.length > 0) {
      this.log(
        `event=idle-timer-postponed reason=${busy.join("+")} ` +
          `state=${this.stateName}`,
      );

      this.idleTimer = setTimeout(() => {
        this.handleIdleTimerFired(ms, reason);
      }, ms);

      return;
    }

    this.log(`event=idle-timer-fired reason=${reason}`);

    this.stop("idle-timeout");
  }

  private clearIdleTimer(reason = "cleared"): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);

      this.idleTimer = null;

      this.log(
        `event=idle-timer-cleared reason=${reason} ` +
          `state=${this.stateName}`,
      );
    }
  }

  /*
   * Arms the watchdog only when nothing is pending — used from
   * per-audio-chunk paths so timers are never churned chunk by chunk.
   */
  private armIdleIfEmpty(ms: number, reason: string): void {
    if (this.idleTimer) {
      return;
    }

    this.scheduleIdle(ms, reason);
  }

  private clearMicStallTimer(): void {
    if (this.micStallTimer) {
      clearTimeout(this.micStallTimer);

      this.micStallTimer = null;
    }
  }

  private cancelDrainWait(): void {
    this.awaitingDrain = false;

    if (this.drainTimer) {
      clearTimeout(this.drainTimer);

      this.drainTimer = null;
    }
  }

  private markResponseInterrupted(): void {
    this.interruptedResponse = true;

    this.interruptedResponseAt = Date.now();

    this.staleDropLogged = false;

    this.loudStreak = 0;

    this.outputLevel = 0;

    this.cancelDrainWait();
  }

  private flushPreRoll(): void {
    for (const b64 of this.preRoll.flush()) {
      if (canSendFrom(this.stateName) && !this.disposed) {
        this.sendAudioChunk(b64);
      }
    }
  }

  /*
   * Rebuilds the capture pipeline with the next mic variant.
   *
   * Failure handling (P0-4): a failed rebuild must never leave a deaf
   * session — the remaining variants are tried, and if none opens the
   * session fails loudly through the existing fatal path.
   */
  private async rebuildMic(): Promise<void> {
    if (this.rebuilding || this.disposed) {
      return;
    }

    this.rebuilding = true;

    try {
      const old = this.mic;

      this.mic = null;

      /*
       * Fully release the old pipeline BEFORE opening a new one — a
       * concurrently-open device can fail or duplicate the pipeline.
       */
      await old?.stop().catch((error: unknown) => {
        this.log(
          `event=mic-stop-failed ` +
            `error=${error instanceof Error ? error.message : String(error)}`,
        );
      });

      while (this.micAttempt < MIC_VARIANTS.length) {
        if (this.disposed || this.stopRequested) {
          return;
        }

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

          if (this.disposed || this.stopRequested) {
            void mic.stop();

            return;
          }

          this.mic = mic;

          this.resampler =
            rate === VOICE_INPUT_RATE
              ? null
              : new LinearResampler(rate, VOICE_INPUT_RATE);

          this.silentStreak = 0;

          this.logEvent(
            `event=mic-rebuilt attempt=${this.micAttempt + 1}/` +
              `${MIC_VARIANTS.length} processing=${variant.processing ? "on" : "off"} ` +
              `source=${variant.useDeviceId && this.chosenDeviceId ? "chosen-device" : "default"} ` +
              `rate=${rate}`,
          );

          return;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);

          this.logEvent(
            `event=mic-rebuild-failed attempt=${this.micAttempt + 1}/` +
              `${MIC_VARIANTS.length} reason=${reason}`,
          );

          if (this.micAttempt >= MIC_VARIANTS.length - 1) {
            break;
          }

          this.micAttempt += 1;
        }
      }

      /*
       * Every capture configuration failed — end the session loudly
       * instead of leaving Starfire alive but unable to hear.
       */
      if (!this.disposed && !this.stopRequested) {
        this.silenceFatal = true;

        this.message = "Microphone is not delivering audio.";

        this.logEvent("event=mic-exhausted note=all capture variants failed");

        this.dispatch({ type: "fatal-error" });

        this.cleanup();
      }
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

    /*
     * Echo-cancelled capture is digitally silent while she speaks —
     * that is normal, so silence only counts as a mic problem when
     * Starfire is NOT the one making sound.
     */
    if (this.stateName !== "assistant-speaking") {
      if (chunk.rms < SILENT_RMS_THRESHOLD) {
        this.silentStreak += 1;
      } else {
        this.silentStreak = 0;
      }
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

        this.logEvent(
          `event=mic-silent-rebuild attempt=${this.micAttempt + 1}/` +
            `${MIC_VARIANTS.length}`,
        );

        void this.rebuildMic();

        return;
      }

      if (!this.silenceFatal) {
        this.silenceFatal = true;

        this.message = "Microphone is not delivering audio.";

        this.logEvent(
          "event=mic-exhausted note=silence persisted across all capture configurations",
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

    if (this.stateName === "assistant-speaking") {
      const echoFloor = Math.max(ECHO_UPLOAD_FLOOR, this.outputLevel * 0.9);

      if (chunk.rms >= echoFloor) {
        this.armIdleIfEmpty(TOOL_ROUND_IDLE_MS, "assistant-active");

        this.sendAudioChunk(b64);
      }

      if (chunk.rms >= LOCAL_BARGE_FLOOR) {
        this.loudStreak += 1;
      } else {
        this.loudStreak = 0;
      }

      if (this.loudStreak >= LOCAL_BARGE_FRAMES) {
        this.loudStreak = 0;

        this.playback?.clear();

        this.mouth.raw = 0;

        this.markResponseInterrupted();

        this.deps.bridge?.interrupt();

        this.logEvent("event=barge-in source=local-fallback");
      }

      return;
    }

    if (now < this.echoCooldownUntil) {
      if (chunk.rms >= ECHO_UPLOAD_FLOOR) {
        if (!this.localSpeech) {
          this.logEvent("event=user-turn-start source=local-echo");

          this.localSpeech = true;

          this.dispatch({ type: "local-speech-start" });
        }

        this.armIdleIfEmpty(VOICE_IDLE_AFTER_ACTIVATION_MS, "user-turn");

        this.gate = new SpeechGate();

        this.sendAudioChunk(b64);
      } else {
        this.gate = new SpeechGate();
      }

      return;
    }

    const gate = this.gate.update(chunk.rms, dt);

    if (gate.started) {
      this.gateEverStarted = true;

      this.armIdleIfEmpty(VOICE_IDLE_AFTER_ACTIVATION_MS, "user-turn");

      this.logEvent("event=user-turn-start source=local-gate");

      this.localSpeech = true;

      this.dispatch({ type: "local-speech-start" });

      this.flushPreRoll();

      this.transmitting = true;

      this.sendAudioChunk(b64);

      return;
    }

    if (this.localSpeech) {
      this.sendAudioChunk(b64);

      if (gate.ended) {
        this.localSpeech = false;

        this.speechEndedAt = now;

        /*
         * The user's turn ended locally — re-arm the idle watchdog so
         * a model that never responds cannot leave the session hanging.
         */
        this.scheduleIdle(VOICE_IDLE_AFTER_RESPONSE_MS, "local-turn-end");
      }

      return;
    }

    if (this.transmitting) {
      if (now - this.speechEndedAt <= VOICE_TAIL_MS) {
        this.sendAudioChunk(b64);

        return;
      }

      this.transmitting = false;

      this.dispatch({ type: "local-speech-end" });
    }

    if (this.failOpen) {
      this.sendAudioChunk(b64);

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
        /*
         * Re-arm the watchdog for the user's turn instead of leaving
         * no timer at all — the fire-time busy guard postpones it
         * while she hears the user or waits for playback.
         */
        this.scheduleIdle(VOICE_IDLE_AFTER_ACTIVATION_MS, "user-turn");

        this.transcript.user = "";

        this.transcript.assistant = "";

        if (this.stateName === "assistant-speaking") {
          this.playback?.clear();

          this.mouth.raw = 0;

          this.markResponseInterrupted();

          this.logEvent("event=barge-in source=server-vad");
        }

        if (!this.transmitting) {
          this.flushPreRoll();

          this.transmitting = true;
        }

        this.turnEndAt = 0;

        this.logEvent("event=user-turn-start source=server");

        this.dispatch({ type: "server-speech-start" });

        break;
      }

      case "speech-stopped": {
        this.logEvent("event=user-turn-end");

        this.transmitting = false;

        this.localSpeech = false;

        this.turnEndAt = Date.now();

        this.dispatch({ type: "server-speech-end" });

        break;
      }

      case "response-created": {
        if (this.interruptedResponse) {
          this.interruptedResponse = false;

          this.staleDropLogged = false;

          this.log("new response started — accepting fresh audio");
        }

        /*
         * A tool round's follow-up response is starting — the tool UI
         * phase ends (App clears the tool bubble) and the state shows
         * "Thinking…" until her voice arrives.
         */
        if (this.toolRoundActive) {
          this.toolRoundActive = false;

          this.deps.onToolEvent?.({ kind: "tool-end" });

          this.dispatch({ type: "tool-followup-start" });

          /*
           * The tool round is over; give the spoken follow-up its own
           * stall budget instead of leaving the old tool timer armed
           * across her response.
           */
          this.scheduleIdle(TOOL_ROUND_IDLE_MS, "tool-followup");
        }

        break;
      }

      case "tool-call": {
        this.toolRoundActive = true;

        this.lastToolEventAt = Date.now();

        this.logEvent(`event=tool-start tool=${event.name}`);

        this.deps.onToolEvent?.({ kind: "tool-call", name: event.name });

        this.scheduleIdle(TOOL_ROUND_IDLE_MS, "tool-round");

        break;
      }

      case "tool-result": {
        this.lastToolEventAt = Date.now();

        this.logEvent(
          `event=tool-result tool-ok=${event.ok ? "true" : "false"}` +
            (event.summary ? ` summary=${event.summary}` : ""),
        );

        this.deps.onToolEvent?.({ kind: "tool-result" });

        /*
         * Restart the tool-round stall watchdog from the LAST result so
         * a slow tool + slow follow-up can never fire the timer armed
         * at tool-call while her response is already playing.
         */
        this.scheduleIdle(TOOL_ROUND_IDLE_MS, "tool-result");

        break;
      }

      case "session-ended": {
        /*
         * She said her goodbye via end_session. Let the farewell audio
         * finish playing, then end cleanly (no reconnect; the wake
         * word resumes). The timer is tracked so it can never leak
         * into a newer session.
         */
        this.goodbyeActive = true;

        this.logEvent("event=goodbye source=end_session");

        this.clearIdleTimer("goodbye");

        this.clearGoodbyeTimer();

        this.goodbyeTimer = setTimeout(() => {
          this.goodbyeTimer = null;

          this.stop("goodbye");
        }, GOODBYE_GRACE_MS);

        break;
      }

      case "audio-transcript-delta": {
        this.transcript.assistant += event.delta;

        break;
      }

      case "input-transcript": {
        this.transcript.user = event.text;

        this.log(`you said: ${event.text}`);

        if (GOODBYE_PATTERN.test(event.text)) {
          this.goodbyeDetected = true;
          this.log("👋 goodbye detected — will close after her farewell");
        }

        break;
      }

      case "response-done": {
        const isToolRound = this.audioChunks === 0 && this.toolRoundActive;

        const buffered = this.audioBufferedMs;

        if (this.audioChunks === 0) {
          if (isToolRound) {
            this.logEvent("event=response-empty kind=tool-turn");
          } else {
            this.logEvent("event=response-empty note=garbled-turn");
          }
        } else {
          this.logEvent(
            `event=response-complete chunks=${this.audioChunks} ` +
              `bufferedMs=${Math.round(buffered)}`,
          );
        }

        this.audioChunks = 0;

        this.audioBufferedMs = 0;

        if (
          buffered > MIN_DRAIN_WAIT_MS &&
          this.stateName === "assistant-speaking"
        ) {
          this.awaitingDrain = true;

          this.logEvent("event=awaiting-playback-drain");

          if (this.drainTimer) {
            clearTimeout(this.drainTimer);
          }

          this.drainTimer = setTimeout(() => {
            this.finishResponseDone();
          }, DRAIN_TIMEOUT_MS);

          if (this.goodbyeDetected) {
            this.logEvent("event=goodbye source=transcript phase=drain");
          }
        } else {
          this.finishResponseDone(
            isToolRound ? TOOL_ROUND_IDLE_MS : VOICE_IDLE_AFTER_RESPONSE_MS,
          );

          if (this.goodbyeDetected && !isToolRound) {
            this.logEvent("event=goodbye source=transcript");

            this.clearGoodbyeTimer();

            this.goodbyeTimer = setTimeout(() => {
              this.goodbyeTimer = null;

              this.stop("goodbye");
            }, 3000);
          }
        }

        break;
      }

      case "response-cancelled": {
        this.logEvent("event=response-cancelled");

        if (this.stateName === "assistant-speaking") {
          this.dispatch({ type: "interrupted" });

          this.scheduleIdle(TOOL_ROUND_IDLE_MS, "interrupted");
        }

        break;
      }

      case "error": {
        if (event.fatal) {
          this.message = event.message.startsWith("Empirio")
            ? event.message
            : "EmpirioLabs authentication failed.";

          this.logEvent(`event=fatal-error error=${this.message}`);

          this.dispatch({ type: "fatal-error" });

          this.cleanup();
        } else {
          console.error(
            `[Starfire Voice] server error (conn=${event.conn}):`,
            event.message,
          );
        }

        break;
      }

      case "closed": {
        if (this.disposed || this.stopRequested || this.goodbyeActive) {
          break;
        }

        if (canSendFrom(this.stateName) || this.stateName === "starting") {
          if (this.reconnectsUsed < MAX_RECONNECTS_PER_SESSION) {
            this.reconnectsUsed += 1;

            this.logEvent(
              `event=reconnect attempt=${this.reconnectsUsed}/` +
                `${MAX_RECONNECTS_PER_SESSION}`,
            );

            void this.reconnect();
          } else {
            this.message = "Voice connection closed.";

            this.logEvent("event=reconnect-exhausted");

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

    this.interruptedResponse = false;

    this.interruptedResponseAt = 0;

    this.staleDropLogged = false;

    this.loudStreak = 0;

    this.toolRoundActive = false;

    this.lastToolEventAt = 0;

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
      /*
       * The reconnect may have opened a socket after cleanup's
       * bridge.stop() — close it so no zombie connection survives.
       */
      this.deps.bridge?.stop();

      this.dispatch({ type: "stop" });

      this.cleanup();

      return;
    }

    if (!connect.ok) {
      this.message = connect.error;

      this.logEvent(`event=reconnect-failed error=${connect.error}`);

      this.dispatch({ type: "stop" });

      this.cleanup();

      return;
    }

    this.playback = this.deps.createPlayback({
      onLevel: (rms) => {
        this.outputLevel = rms;

        this.lastLevelAt = Date.now();

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

    this.lastAudioAt = 0;

    this.lastLevelAt = 0;

    this.dispatch({ type: "session-ready" });

    this.scheduleIdle(VOICE_IDLE_AFTER_ACTIVATION_MS, "reconnected");

    this.logEvent("event=reconnected");
  }

  private handlePlaybackDrained(): void {
    this.mouth.raw = 0;

    this.outputLevel = 0;

    if (this.goodbyeActive || this.goodbyeDetected) {
      this.cancelDrainWait();

      this.stop("goodbye");

      return;
    }

    if (this.awaitingDrain) {
      this.logEvent("event=playback-drained");

      this.finishResponseDone();

      return;
    }

    /*
     * Playback ended without a response.done (server stalled) — finish
     * the response anyway so the session can never hang in
     * assistant-speaking with no watchdog armed.
     */
    if (this.stateName === "assistant-speaking") {
      this.logEvent(
        "event=playback-drained note=no response.done — finishing response",
      );

      this.finishResponseDone(TOOL_ROUND_IDLE_MS);
    }
  }

  private finishResponseDone(
    idleMs: number = VOICE_IDLE_AFTER_RESPONSE_MS,
  ): void {
    this.cancelDrainWait();

    this.echoCooldownUntil = Date.now() + ECHO_COOLDOWN_MS;

    this.gate = new SpeechGate();

    this.dispatch({ type: "response-done" });

    this.scheduleIdle(idleMs, "response-done");
  }

  private handlePcm(pcm: ArrayBuffer): void {
    if (
      this.disposed ||
      this.stateName === "closing" ||
      this.stateName === "idle"
    ) {
      return;
    }

    if (this.interruptedResponse) {
      if (Date.now() - this.interruptedResponseAt > STALE_DROP_WINDOW_MS) {
        this.interruptedResponse = false;

        this.staleDropLogged = false;

        this.log("stale-drop window expired — accepting fresh audio");
      } else {
        if (!this.staleDropLogged) {
          this.staleDropLogged = true;

          this.logEvent("event=stale-audio-dropped source=interrupted");
        }

        return;
      }
    }

    this.toolRoundActive = false;

    this.lastAudioAt = Date.now();

    if (!this.loggedFirstAudio) {
      this.loggedFirstAudio = true;

      this.logEvent("event=assistant-audio-start");

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

    this.clearIdleTimer("cleanup");

    this.clearMicStallTimer();

    this.clearGoodbyeTimer();

    if (this.failOpenTimer) {
      clearTimeout(this.failOpenTimer);

      this.failOpenTimer = null;
    }

    this.cancelDrainWait();

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

    this.outputLevel = 0;

    this.transmitting = false;

    this.localSpeech = false;

    this.resampler = null;

    this.captureReady = false;

    this.toolRoundActive = false;

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
