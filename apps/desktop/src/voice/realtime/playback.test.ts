import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildPlaybackMessage,
  createPlaybackPipeline,
  OUTPUT_SAMPLE_RATE,
} from "./playback";

describe("buildPlaybackMessage", () => {
  it("wraps samples in the { pcm } object contract", () => {
    const samples = new Float32Array([0.1, -0.2, 0.3]);

    const message = buildPlaybackMessage(samples);

    expect(message).toEqual({ pcm: samples });
    expect(message.pcm).toBe(samples);
  });
});

describe("OUTPUT_SAMPLE_RATE", () => {
  it("is 24 kHz — the model's documented output rate", () => {
    expect(OUTPUT_SAMPLE_RATE).toBe(24000);
  });
});

describe("play-worklet message contract", () => {
  const workletSource = readFileSync(
    new URL("../../../public/worklets/play-worklet.js", import.meta.url),
    "utf8",
  );

  it("reads audio from data.pcm (matches buildPlaybackMessage)", () => {
    expect(workletSource).toContain("data?.pcm");
  });

  it("handles the { type: 'clear' } flush message", () => {
    expect(workletSource).toContain('"clear"');
  });

  it("is a sink: no inputs, one output", () => {
    expect(workletSource).toContain("registerProcessor");
    expect(workletSource).toContain("outputs[0][0]");
  });

  it("reports the drained event so her state can follow the audible tail", () => {
    expect(workletSource).toContain('"drained"');
  });
});

/*
 * P0 regressions at the pipeline level: bursty pushes must share ONE
 * AudioContext, and a stop racing an in-flight startup must close the
 * context instead of leaking it.
 */

class FakeAudioContext {
  sampleRate = 48000;

  state = "running";

  closed = false;

  destination = { dummy: true };

  resume = vi.fn(async () => {});

  close = vi.fn(async () => {
    this.closed = true;

    this.state = "closed";
  });

  audioWorklet = {
    addModule: vi.fn(async () => {}),
  };

  createGain = vi.fn(() => ({
    gain: { value: 1 },

    connect: vi.fn(),

    disconnect: vi.fn(),
  }));
}

class FakeWorkletNode {
  port = {
    onmessage: null as ((event: unknown) => void) | null,

    postMessage: vi.fn(),
  };

  connect = vi.fn();

  disconnect = vi.fn();
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

function stubAudioGlobals(): { contexts: FakeAudioContext[] } {
  const contexts: FakeAudioContext[] = [];

  vi.stubGlobal("document", { baseURI: "http://localhost/" });

  vi.stubGlobal(
    "AudioContext",
    class extends FakeAudioContext {
      constructor() {
        super();

        contexts.push(this);
      }
    },
  );

  vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);

  return { contexts };
}

describe("playback pipeline races", () => {
  beforeEach(() => {});

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a burst of pushes creates exactly one AudioContext", async () => {
    const { contexts } = stubAudioGlobals();

    const pipeline = createPlaybackPipeline({
      onLevel: vi.fn(),
    });

    const pcm = new ArrayBuffer(1920);

    pipeline.push(pcm);

    pipeline.push(pcm);

    pipeline.push(pcm);

    await flushMicrotasks();

    expect(contexts).toHaveLength(1);

    await pipeline.stop();

    expect(contexts[0].closed).toBe(true);
  });

  it("stop during warmup closes the context and silences later pushes", async () => {
    let release: (() => void) | undefined;

    const { contexts } = stubAudioGlobals();

    const pipeline = createPlaybackPipeline({
      onLevel: vi.fn(),
    });

    const warming = pipeline.warmup();

    const stopping = pipeline.stop();

    release?.();

    await warming;

    await stopping;

    pipeline.push(new ArrayBuffer(1920));

    await flushMicrotasks();

    for (const context of contexts) {
      expect(context.closed).toBe(true);
    }
  });

  it("an addModule failure cleans up the created context", async () => {
    const { contexts } = stubAudioGlobals();

    vi.stubGlobal(
      "AudioContext",
      class extends FakeAudioContext {
        constructor() {
          super();

          contexts.push(this);

          this.audioWorklet.addModule = vi.fn(async () => {
            throw new Error("Unable to load a worklet's module");
          });
        }
      },
    );

    const pipeline = createPlaybackPipeline({
      onLevel: vi.fn(),
    });

    await pipeline.warmup();

    expect(contexts).toHaveLength(1);

    expect(contexts[0].closed).toBe(true);
  });
});
