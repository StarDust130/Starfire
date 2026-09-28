import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildPlaybackMessage, OUTPUT_SAMPLE_RATE } from "./playback";

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
