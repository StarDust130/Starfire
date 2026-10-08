import { LinearResampler, pcm16ToFloat } from "./audio";

import { resolveWorkletUrl } from "./microphone";

export const OUTPUT_SAMPLE_RATE = 24000;

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

/*
 * Message contract with play-worklet.js:
 *   { pcm: Float32Array }   -> audio
 *   { type: "clear" }       -> flush queue instantly (barge-in)
 *   { type: "level", rms }  <- real-time output loudness (play-time,
 *                              NOT push-time — this is what keeps
 *                              her mouth moving for the whole reply)
 *   { type: "drained" }     <- queue ran empty after playing
 */
export function buildPlaybackMessage(samples: Float32Array): {
  pcm: Float32Array;
} {
  return { pcm: samples };
}

/*
 * One reusable output pipeline per voice session. warmup() creates
 * the AudioContext and loads the worklet BEFORE the first audio
 * chunk arrives (during connection), removing 100-200ms of dead
 * time before her first word.
 */
export function createPlaybackPipeline(handlers: {
  onLevel: (rms: number) => void;

  onDiagnostic?: (message: string) => void;

  onDrained?: () => void;
}): PlaybackPipeline {
  let context: AudioContext | null = null;

  let node: AudioWorkletNode | null = null;

  let resampler: LinearResampler | null = null;

  let stopped = false;

  let startPromise: Promise<void> | null = null;

  async function createPipeline(): Promise<void> {
    let created: AudioContext | null = null;

    try {
      created = new AudioContext();

      if (stopped) {
        throw new Error("Playback stopped while starting.");
      }

      context = created;

      if (context.state === "suspended") {
        await context.resume();
      }

      if (stopped) {
        throw new Error("Playback stopped while starting.");
      }

      await context.audioWorklet.addModule(
        resolveWorkletUrl("play-worklet.js"),
      );

      if (stopped) {
        throw new Error("Playback stopped while starting.");
      }

      const worklet = new AudioWorkletNode(context, "starfire-play", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });

      worklet.port.onmessage = (event: MessageEvent) => {
        const data = event.data as { type?: string; rms?: number };

        if (data?.type === "drained") {
          handlers.onDrained?.();

          return;
        }

        if (data?.type === "level" && typeof data.rms === "number") {
          handlers.onLevel(data.rms);
        }
      };

      worklet.connect(context.destination);

      node = worklet;

      resampler = new LinearResampler(OUTPUT_SAMPLE_RATE, context.sampleRate);

      handlers.onDiagnostic?.(
        `output pipeline live (${context.sampleRate} Hz, ` +
          `${OUTPUT_SAMPLE_RATE}->${context.sampleRate} resampled)`,
      );

      created = null;
    } finally {
      /*
       * If the pipeline never came up (stop raced the startup, or an
       * error occurred), close the context we created — never leak it.
       */
      if (created) {
        if (context === created) {
          context = null;
        }

        await closeContext(created);
      }
    }
  }

  async function closeContext(target: AudioContext): Promise<void> {
    if (target.state !== "closed") {
      await target.close().catch(() => {});
    }
  }

  function ensureStarted(): Promise<void> {
    if (context) {
      if (context.state === "suspended") {
        return context.resume().then(() => {});
      }

      return Promise.resolve();
    }

    /*
     * Audio chunks arrive in bursts; concurrent startups must share ONE
     * pipeline or every racing call would create its own AudioContext.
     */
    if (!startPromise) {
      startPromise = createPipeline().finally(() => {
        startPromise = null;
      });
    }

    return startPromise;
  }

  async function warmup(): Promise<void> {
    try {
      await ensureStarted();
    } catch (error) {
      if (!stopped) {
        console.error("[Starfire Voice] playback warmup failed:", error);
      }
    }
  }

  function push(pcm: ArrayBuffer): void {
    if (stopped) {
      return;
    }

    ensureStarted()
      .then(() => {
        if (!node || stopped) {
          return;
        }

        const source = pcm16ToFloat(new Int16Array(pcm));

        const samples = resampler ? resampler.process(source) : source;

        const copy = new Float32Array(samples);

        node.port.postMessage(buildPlaybackMessage(copy), [copy.buffer]);
      })
      .catch((error) => {
        if (!stopped) {
          console.error("[Starfire Voice] playback failed:", error);
        }
      });
  }

  function clear(): void {
    node?.port.postMessage({ type: "clear" });

    handlers.onLevel(0);
  }

  async function stop(): Promise<void> {
    stopped = true;

    clear();

    /*
     * Wait for an in-flight startup so it cannot create resources
     * after the teardown below, then tear everything down.
     */
    if (startPromise) {
      await startPromise.catch(() => {});
    }

    node?.disconnect();

    node = null;

    const closing = context;

    context = null;

    resampler = null;

    if (closing) {
      await closeContext(closing);
    }
  }

  return { warmup, push, clear, stop };
}
