export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/*
 * Float32 [-1, 1] -> signed 16-bit little-endian PCM.
 * Always clamped; never NaN (NaN input becomes 0).
 */
export function floatToPcm16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);

  for (let i = 0; i < input.length; i += 1) {
    let sample = input[i];

    if (!Number.isFinite(sample)) {
      sample = 0;
    }

    sample = clamp(sample, -1, 1);

    output[i] = Math.round(sample * 32767);
  }

  return output;
}

export function pcm16ToFloat(input: Int16Array): Float32Array {
  const output = new Float32Array(input.length);

  for (let i = 0; i < input.length; i += 1) {
    output[i] = input[i] / 32768;
  }

  return output;
}

export function bytesToBase64(bytes: Int16Array | Uint8Array): string {
  const view =
    bytes instanceof Int16Array
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : bytes;

  let binary = "";

  const chunkSize = 0x8000;

  for (let i = 0; i < view.length; i += chunkSize) {
    const chunk = view.subarray(i, Math.min(i + chunkSize, view.length));

    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);

  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

export function computeRms(samples: Float32Array): number {
  if (samples.length === 0) {
    return 0;
  }

  let sum = 0;

  for (let i = 0; i < samples.length; i += 1) {
    const value = Number.isFinite(samples[i]) ? samples[i] : 0;

    sum += value * value;
  }

  return Math.sqrt(sum / samples.length);
}

/*
 * Soft nonlinear curve: quiet speech still moves the mouth, loud
 * speech saturates smoothly. Always bounded [0, 1], never NaN.
 */
export function mouthFromRms(rms: number): number {
  const level = Number.isFinite(rms) ? Math.max(rms, 0) : 0;

  const x = clamp(level * 2.2, 0, 4);

  return clamp((x / (x + 0.28)) * 1.25, 0, 1);
}

/*
 * Frame-rate-independent mouth smoothing: fast attack, slower
 * release. NaN/Infinity targets are treated as silence.
 */
export class MouthSmoother {
  private value = 0;

  update(target: number, dt: number): number {
    const goal = Number.isFinite(target) ? clamp(target, 0, 1) : 0;

    const safeDt = Number.isFinite(dt) ? Math.max(dt, 0) : 0;

    const rate = goal > this.value ? 16 : 7;

    const k = 1 - Math.exp(-rate * safeDt);

    this.value += (goal - this.value) * k;

    this.value = clamp(this.value, 0, 1);

    return this.value;
  }

  reset(): void {
    this.value = 0;
  }

  get current(): number {
    return this.value;
  }
}

/*
 * Continuous linear-interpolation resampler that carries phase
 * across chunk boundaries. Bounded output, no NaN, no drift.
 */
export class LinearResampler {
  private readonly step: number;

  private t = 0;

  private lastValue = 0;

  constructor(fromRate: number, toRate: number) {
    this.step = toRate > 0 && fromRate > 0 ? fromRate / toRate : 1;
  }

  process(input: Float32Array): Float32Array {
    if (input.length === 0) {
      return new Float32Array(0);
    }

    if (this.step === 1) {
      return input.slice();
    }

    const outLen = Math.max(
      0,
      Math.ceil(
        (input.length - 1 - Math.min(this.t, input.length - 1)) / this.step,
      ),
    );

    const output = new Float32Array(outLen);

    for (let j = 0; j < outLen; j += 1) {
      const idx = this.t + j * this.step;

      let value: number;

      if (idx < 0) {
        const f = clamp(idx + 1, 0, 1);

        value = this.lastValue * (1 - f) + input[0] * f;
      } else if (idx >= input.length - 1) {
        value = input[input.length - 1];
      } else {
        const i0 = Math.floor(idx);

        const f = idx - i0;

        value = input[i0] * (1 - f) + input[i0 + 1] * f;
      }

      output[j] = Number.isFinite(value) ? value : 0;
    }

    this.t += outLen * this.step - input.length;

    this.lastValue = input[input.length - 1];

    return output;
  }
}

/*
 * Rolling pre-roll buffer of base64 PCM chunks. Keeps the most
 * recent `maxSamples` worth of audio so the first phoneme of a
 * turn is never clipped.
 */
export class PreRollBuffer {
  private chunks: Array<{ b64: string; samples: number }> = [];

  private total = 0;

  constructor(private readonly maxSamples: number) {}

  push(b64: string, samples: number): void {
    this.chunks.push({ b64, samples });

    this.total += samples;

    while (this.total > this.maxSamples && this.chunks.length > 1) {
      const dropped = this.chunks.shift();

      if (dropped) {
        this.total -= dropped.samples;
      }
    }
  }

  flush(): string[] {
    const list = this.chunks.map((chunk) => chunk.b64);

    this.chunks = [];

    this.total = 0;

    return list;
  }

  clear(): void {
    this.chunks = [];

    this.total = 0;
  }
}

export type SpeechGateOptions = {
  startFactor?: number;
  endFactor?: number;
  absolute?: number;
  quietMs?: number;
  floorRisePerMs?: number;
  floorFallPerMs?: number;
};

export type SpeechGateResult = {
  started: boolean;
  ended: boolean;
  speaking: boolean;
  floor: number;
};

/*
 * Adaptive hysteresis speech gate for TRANSMISSION GATING ONLY.
 * Server-side VAD remains the authority for conversational turns.
 */
export class SpeechGate {
  private floor: number;

  private speaking = false;

  private quietFor = 0;

  private readonly startFactor: number;
  private readonly endFactor: number;
  private readonly absolute: number;
  private readonly quietMs: number;
  private readonly floorRisePerMs: number;
  private readonly floorFallPerMs: number;

  constructor(options: SpeechGateOptions = {}) {
    this.startFactor = options.startFactor ?? 3.2;
    this.endFactor = options.endFactor ?? 2.2;
    this.absolute = options.absolute ?? 0.006;
    this.quietMs = options.quietMs ?? 180;
    this.floorRisePerMs = options.floorRisePerMs ?? 0.001;
    this.floorFallPerMs = options.floorFallPerMs ?? 0.08;
    this.floor = 0.0015;
  }

  update(rms: number, dtMs: number): SpeechGateResult {
    const level = Number.isFinite(rms) ? Math.max(rms, 0) : 0;

    const dt = clamp(Number.isFinite(dtMs) ? dtMs : 20, 1, 100);

    const rate = level < this.floor ? this.floorFallPerMs : this.floorRisePerMs;

    this.floor += (level - this.floor) * Math.min(1, rate * dt);

    const startThreshold = Math.max(
      this.absolute,
      this.floor * this.startFactor,
    );

    const endThreshold = Math.max(
      this.absolute * 0.7,
      this.floor * this.endFactor,
    );

    let started = false;
    let ended = false;

    if (!this.speaking) {
      if (level >= startThreshold) {
        this.speaking = true;

        this.quietFor = 0;

        started = true;
      }
    } else if (level < endThreshold) {
      this.quietFor += dt;

      if (this.quietFor >= this.quietMs) {
        this.speaking = false;

        ended = true;

        this.quietFor = 0;
      }
    } else {
      this.quietFor = 0;
    }

    return {
      started,
      ended,
      speaking: this.speaking,
      floor: this.floor,
    };
  }
}
