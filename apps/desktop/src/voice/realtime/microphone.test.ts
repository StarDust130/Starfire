import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMicPipeline, type MicPipeline } from "./microphone";

/*
 * P0-4 regressions at the pipeline level: a stop() that races an
 * in-flight start() must never leak an AudioContext or MediaStream.
 */

type Recorded = {
  contexts: FakeAudioContext[];

  tracks: FakeTrack[];

  getUserMediaCalls: number;
};

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

  createMediaStreamSource = vi.fn(() => ({
    connect: vi.fn(),

    disconnect: vi.fn(),
  }));

  createGain = vi.fn(() => ({
    gain: { value: 1 },

    connect: vi.fn(),

    disconnect: vi.fn(),
  }));
}

class FakeWorkletNode {
  port = {
    onmessage: null as ((event: unknown) => void) | null,

    close: vi.fn(),

    postMessage: vi.fn(),
  };

  connect = vi.fn();

  disconnect = vi.fn();
}

class FakeTrack {
  label = "Fake Microphone";

  readyState = "live";

  stopped = false;

  stop = vi.fn(() => {
    this.stopped = true;
  });

  getSettings = vi.fn(() => ({ deviceId: "dev-1" }));

  addEventListener = vi.fn();
}

function stubGlobals(options?: {
  gateGetUserMedia?: Promise<unknown>;

  gateAddModule?: Promise<void>;
}): Recorded {
  const recorded: Recorded = {
    contexts: [],

    tracks: [],

    getUserMediaCalls: 0,
  };

  const track = new FakeTrack();

  recorded.tracks.push(track);

  vi.stubGlobal("document", { baseURI: "http://localhost/" });

  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn(async () => {
        recorded.getUserMediaCalls += 1;

        if (options?.gateGetUserMedia) {
          return options.gateGetUserMedia;
        }

        const stream = {
          getTracks: () => [track],

          getAudioTracks: () => [track],
        };

        return stream;
      }),
    },
  });

  vi.stubGlobal(
    "AudioContext",
    class extends FakeAudioContext {
      constructor() {
        super();

        if (options?.gateAddModule) {
          this.audioWorklet.addModule = vi.fn(async () => {
            await options.gateAddModule;
          });
        }

        recorded.contexts.push(this);
      }
    },
  );

  vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);

  return recorded;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

function makePipeline(recorded: Recorded): MicPipeline {
  void recorded;

  return createMicPipeline(
    {
      onChunk: vi.fn(),

      onDiagnostic: vi.fn(),
    },
    { processing: true, useDeviceId: true },
    "dev-1",
  );
}

beforeEach(() => {});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mic pipeline lifecycle", () => {
  it("opens, and stops without leaks", async () => {
    const recorded = stubGlobals();

    const pipeline = makePipeline(recorded);

    const rate = await pipeline.start();

    expect(rate).toBe(48000);

    await pipeline.stop();

    expect(recorded.tracks[0].stop).toHaveBeenCalled();

    expect(recorded.contexts[0].closed).toBe(true);
  });

  it("P0-4: stop during the stream acquire aborts with no leaked context", async () => {
    let release: ((stream: unknown) => void) | undefined;

    const recorded = stubGlobals({
      gateGetUserMedia: new Promise((resolve) => {
        release = resolve;
      }),
    });

    const pipeline = makePipeline(recorded);

    const starting = pipeline.start();

    await flushMicrotasks();

    const stopping = pipeline.stop();

    release?.({
      getTracks: () => recorded.tracks,

      getAudioTracks: () => [recorded.tracks[0]],
    });

    await expect(starting).rejects.toThrow(/stopped while starting/i);

    await stopping;

    expect(recorded.tracks[0].stop).toHaveBeenCalled();

    expect(recorded.contexts).toHaveLength(0);
  });

  it("P0-4: stop during worklet loading closes the created context", async () => {
    let release: (() => void) | undefined;

    const recorded = stubGlobals({
      gateAddModule: new Promise<void>((resolve) => {
        release = resolve;
      }),
    });

    const pipeline = makePipeline(recorded);

    const starting = pipeline.start();

    await flushMicrotasks();

    const stopping = pipeline.stop();

    release?.();

    await expect(starting).rejects.toThrow(/stopped while starting/i);

    await stopping;

    expect(recorded.tracks[0].stop).toHaveBeenCalled();

    expect(recorded.contexts).toHaveLength(1);

    expect(recorded.contexts[0].closed).toBe(true);
  });

  it("double stop is safe", async () => {
    const recorded = stubGlobals();

    const pipeline = makePipeline(recorded);

    await pipeline.start();

    await pipeline.stop();

    await pipeline.stop();

    expect(recorded.tracks[0].stop).toHaveBeenCalledTimes(1);
  });
});
