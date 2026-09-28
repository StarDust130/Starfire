import { computeRms, LinearResampler, pcm16ToFloat } from "./audio";

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
 *   { pcm: Float32Array }  -> audio
 *   { type: "clear" }      -> flush queue instantly (barge-in)
 *   { type: "drained" }    <- queue ran empty after playing
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

  async function ensureStarted(): Promise<void> {
    if (context) {
      if (context.state === "suspended") {
        await context.resume();
      }

      return;
    }

    try {
      context = new AudioContext();
    } catch {
      context = new AudioContext();
    }

    if (context.state === "suspended") {
      await context.resume();
    }

    await context.audioWorklet.addModule(resolveWorkletUrl("play-worklet.js"));

    node = new AudioWorkletNode(context, "starfire-play", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    node.port.onmessage = (event: MessageEvent) => {
      const data = event.data as { type?: string };

      if (data?.type === "drained") {
        handlers.onDrained?.();
      }
    };

    node.connect(context.destination);

    resampler = new LinearResampler(OUTPUT_SAMPLE_RATE, context.sampleRate);

    handlers.onDiagnostic?.(
      `output pipeline live (${context.sampleRate} Hz, ` +
        `${OUTPUT_SAMPLE_RATE}->${context.sampleRate} resampled)`,
    );
  }

  async function warmup(): Promise<void> {
    try {
      await ensureStarted();
    } catch (error) {
      console.error("[Starfire Voice] playback warmup failed:", error);
    }
  }

  function push(pcm: ArrayBuffer): void {
    if (stopped) {
      return;
    }

    void ensureStarted()
      .then(() => {
        if (!node || stopped) {
          return;
        }

        const source = pcm16ToFloat(new Int16Array(pcm));

        const samples = resampler ? resampler.process(source) : source;

        handlers.onLevel(computeRms(samples));

        const copy = new Float32Array(samples);

        node.port.postMessage(buildPlaybackMessage(copy), [copy.buffer]);
      })
      .catch((error) => {
        console.error("[Starfire Voice] playback failed:", error);
      });
  }

  function clear(): void {
    node?.port.postMessage({ type: "clear" });

    handlers.onLevel(0);
  }

  async function stop(): Promise<void> {
    stopped = true;

    clear();

    node?.disconnect();

    node = null;

    if (context && context.state !== "closed") {
      await context.close();
    }

    context = null;

    resampler = null;
  }

  return { warmup, push, clear, stop };
}
