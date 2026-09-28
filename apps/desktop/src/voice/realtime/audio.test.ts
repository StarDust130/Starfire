import { describe, expect, it } from "vitest";

import {
  MouthSmoother,
  PreRollBuffer,
  SpeechGate,
  base64ToBytes,
  bytesToBase64,
  computeRms,
  floatToPcm16,
  mouthFromRms,
  pcm16ToFloat,
  LinearResampler,
} from "./audio";

describe("floatToPcm16", () => {
  it("clamps and converts", () => {
    const pcm = floatToPcm16(new Float32Array([-2, -1, 0, 1, 2]));

    expect(pcm[0]).toBe(-32767);
    expect(pcm[1]).toBe(-32767);
    expect(pcm[2]).toBe(0);
    expect(pcm[3]).toBe(32767);
    expect(pcm[4]).toBe(32767);
  });

  it("never produces NaN", () => {
    const pcm = floatToPcm16(
      new Float32Array([Number.NaN, Number.POSITIVE_INFINITY]),
    );

    expect(Number.isNaN(pcm[0])).toBe(false);
    expect(Number.isNaN(pcm[1])).toBe(false);
  });
});

describe("pcm16ToFloat", () => {
  it("round-trips within one LSB", () => {
    const original = new Float32Array([0, 0.25, -0.5, 0.999]);

    const round = pcm16ToFloat(floatToPcm16(original));

    for (let i = 0; i < original.length; i += 1) {
      expect(Math.abs(round[i] - original[i])).toBeLessThan(0.0001);
    }
  });
});

describe("base64", () => {
  it("round-trips bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);

    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});

describe("computeRms", () => {
  it("is 0 for silence and correct for a constant", () => {
    expect(computeRms(new Float32Array(480))).toBe(0);

    expect(computeRms(new Float32Array(100).fill(0.5))).toBeCloseTo(0.5, 5);
  });

  it("treats NaN samples as silence", () => {
    const samples = new Float32Array([Number.NaN, 0.5, 0.5]);

    expect(computeRms(samples)).toBeCloseTo(Math.sqrt(0.5 / 3), 5);
  });
});

describe("mouthFromRms", () => {
  it("is bounded, monotonic, and NaN-safe", () => {
    expect(mouthFromRms(0)).toBe(0);

    expect(mouthFromRms(Number.NaN)).toBe(0);

    const low = mouthFromRms(0.02);

    const mid = mouthFromRms(0.1);

    const high = mouthFromRms(0.5);

    expect(low).toBeGreaterThan(0);
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
    expect(high).toBeLessThanOrEqual(1);
  });
});

describe("MouthSmoother", () => {
  it("has no NaN with hostile input", () => {
    const smoother = new MouthSmoother();

    smoother.update(Number.NaN, 0.016);

    smoother.update(Number.POSITIVE_INFINITY, Number.NaN);

    expect(Number.isNaN(smoother.current)).toBe(false);

    expect(Number.isFinite(smoother.current)).toBe(true);
  });

  it("attacks fast and decays back to ~0", () => {
    const smoother = new MouthSmoother();

    let value = 0;

    for (let i = 0; i < 10; i += 1) {
      value = smoother.update(1, 1 / 60);
    }

    expect(value).toBeGreaterThan(0.7);

    for (let i = 0; i < 90; i += 1) {
      value = smoother.update(0, 1 / 60);
    }

    expect(value).toBeLessThan(0.01);
  });
});

describe("LinearResampler", () => {
  it("copies 1:1 when rates match", () => {
    const resampler = new LinearResampler(16000, 16000);

    const input = new Float32Array([0.1, 0.2, 0.3]);

    expect(resampler.process(input)).toEqual(input);
  });

  it("downsamples 3:1 with no NaN and bounded output", () => {
    const resampler = new LinearResampler(48000, 16000);

    let all: Float32Array = new Float32Array(0);

    for (let chunk = 0; chunk < 10; chunk += 1) {
      const input = new Float32Array(960);

      for (let i = 0; i < input.length; i += 1) {
        input[i] = Math.sin((chunk * 960 + i) * 0.01) * 0.8;
      }

      const out = resampler.process(input);

      expect(Math.abs(out.length - 320)).toBeLessThanOrEqual(2);

      for (const value of out) {
        expect(Number.isNaN(value)).toBe(false);
        expect(Math.abs(value)).toBeLessThanOrEqual(1.01);
      }

      const merged = new Float32Array(all.length + out.length);

      merged.set(all);

      merged.set(out, all.length);

      all = merged;
    }

    expect(all.length).toBeGreaterThan(3000);
  });

  it("resamples 44.1k -> 16k continuously across chunks", () => {
    const resampler = new LinearResampler(44100, 16000);

    let total = 0;

    for (let chunk = 0; chunk < 20; chunk += 1) {
      const out = resampler.process(new Float32Array(882).fill(0.5));

      for (const value of out) {
        expect(Number.isNaN(value)).toBe(false);
      }

      total += out.length;
    }

    expect(Math.abs(total - 20 * 320)).toBeLessThanOrEqual(20);
  });
});

describe("PreRollBuffer", () => {
  it("flushes in FIFO order and enforces the cap", () => {
    const preRoll = new PreRollBuffer(100);

    preRoll.push("a", 60);
    preRoll.push("b", 60);

    const flushed = preRoll.flush();

    expect(flushed).toEqual(["b"]);

    expect(flushed).not.toContain("a");
  });

  it("clear() empties everything", () => {
    const preRoll = new PreRollBuffer(1000);

    preRoll.push("a", 10);

    preRoll.clear();

    expect(preRoll.flush()).toEqual([]);
  });
});

describe("SpeechGate", () => {
  it("starts on loud input and ends after sustained quiet", () => {
    const gate = new SpeechGate();

    expect(gate.update(0.001, 20).started).toBe(false);

    expect(gate.update(0.2, 20).started).toBe(true);

    let result = gate.update(0.2, 20);

    expect(result.speaking).toBe(true);

    let ended = false;

    for (let i = 0; i < 20; i += 1) {
      result = gate.update(0.0005, 20);

      if (result.ended) {
        ended = true;
      }
    }

    expect(ended).toBe(true);
  });

  it("adapts its noise floor", () => {
    const gate = new SpeechGate();

    for (let i = 0; i < 200; i += 1) {
      gate.update(0.002, 20);
    }

    expect(gate.update(0.002, 20).floor).toBeLessThan(0.004);
  });

  it("lets quiet speech through (above absolute threshold)", () => {
    const gate = new SpeechGate();

    expect(gate.update(0.02, 20).started).toBe(true);
  });
});
