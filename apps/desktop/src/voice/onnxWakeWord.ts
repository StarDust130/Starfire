import WakeWordEngine from "@edyrkaj/openwakeword-wasm-browser";

const WAKE_WORD = "starfire";

const DETECTION_THRESHOLD = 0.35; // temporary testing threshold
const COOLDOWN_MS = 1500;

export type WakeEngine = {
  load(): Promise<void>;

  start(
    deviceId: string | undefined,
    onDetected: (word: string, score: number) => void,
  ): Promise<void>;

  stop(): Promise<void>;

  isLoaded(): boolean;
};

export async function createOnnxWakeWord(): Promise<WakeEngine> {
  const engine = new WakeWordEngine({
    /*
     * All OpenWakeWord assets live here:
     *
     * public/openwakeword/models/
     */
    baseAssetUrl: "/openwakeword/models",

    /*
     * Our custom wake word.
     */
    keywords: [WAKE_WORD],

    /*
     * Map keyword -> ONNX file.
     */
    modelFiles: {
      [WAKE_WORD]: "starfire.onnx",
    },

    /*
     * Your model is split into:
     *
     * starfire.onnx
     * starfire.onnx.data
     *
     * `path` must match the external-data
     * location stored inside the ONNX file.
     *
     * `data` is the URL/path where the browser
     * gets that external data.
     */
    externalDataFiles: {
      "starfire.onnx": {
        path: "starfire.onnx.data",
        data: "starfire.onnx.data",
      },
    },

    /*
     * OpenWakeWord defaults.
     */
    frameSize: 1280,
    sampleRate: 16000,

    /*
     * Temporary testing threshold.
     *
     * Once Starfire is confirmed working,
     * we can raise this to 0.55+.
     */
    detectionThreshold: DETECTION_THRESHOLD,

    cooldownMs: COOLDOWN_MS,

    /*
     * Keep the package's built-in VAD enabled.
     */
    vadHangoverFrames: 12,

    /*
     * Let the package use its normal
     * ONNX Runtime Web WASM setup.
     */
    executionProviders: ["wasm"],

    /*
     * VERY IMPORTANT:
     * enable package debug logging.
     *
     * This will let us see:
     * - VAD result
     * - Starfire score
     * - detection decisions
     */
    debug: true,
  });

  let loaded = false;

  let removeDetectListener: (() => void) | null = null;

  let removeSpeechStartListener: (() => void) | null = null;

  let removeSpeechEndListener: (() => void) | null = null;

  let removeErrorListener: (() => void) | null = null;

  async function load(): Promise<void> {
    if (loaded) {
      return;
    }

    console.log("[Starfire Wake] Loading wake-word engine...");

    await engine.load();

    /*
     * Make absolutely sure only Starfire
     * is active.
     */
    engine.setActiveKeywords([WAKE_WORD]);

    loaded = true;

    console.log("[Starfire Wake] ✅ Engine loaded");

    console.log(`[Starfire Wake] 🎯 Wake word: ${WAKE_WORD}`);
  }

  function removeListeners(): void {
    removeDetectListener?.();
    removeDetectListener = null;

    removeSpeechStartListener?.();
    removeSpeechStartListener = null;

    removeSpeechEndListener?.();
    removeSpeechEndListener = null;

    removeErrorListener?.();
    removeErrorListener = null;
  }

  async function start(
    deviceId: string | undefined,
    onDetected: (word: string, score: number) => void,
  ): Promise<void> {
    await load();

    /*
     * Avoid duplicate listeners when restarting.
     */
    removeListeners();

    removeSpeechStartListener = engine.on("speech-start", () => {
      console.log("[Starfire Wake] 🗣️ Speech detected");
    });

    removeSpeechEndListener = engine.on("speech-end", () => {
      console.log("[Starfire Wake] 🔇 Speech ended");
    });

    removeDetectListener = engine.on("detect", ({ keyword, score }) => {
      /*
       * Ignore anything that isn't our
       * Starfire model.
       */
      if (keyword.toLowerCase() !== WAKE_WORD) {
        return;
      }

      console.log(
        `[Starfire Wake] ✅ DETECTED "${keyword}" score=${score.toFixed(3)}`,
      );

      onDetected(WAKE_WORD, score);
    });

    removeErrorListener = engine.on("error", (error) => {
      console.error("[Starfire Wake] ❌ Engine error:", error);
    });

    /*
     * The library handles microphone capture,
     * 16kHz audio, VAD, mel spectrogram,
     * embeddings and ONNX inference.
     */
    await engine.start({
      deviceId,
      gain: 1,
    });

    console.log("[Starfire Wake] 🎤 Listening for Starfire...");
  }

  async function stop(): Promise<void> {
    removeListeners();

    await engine.stop();

    console.log("[Starfire Wake] 🛑 Stopped");
  }

  return {
    load,
    start,
    stop,

    isLoaded: () => loaded,
  };
}
