const TARGET_SAMPLE_RATE = 16_000;

const SPEECH_RMS_THRESHOLD = 0.012;
const SILENCE_DURATION_MS = 650;
const MIN_SPEECH_DURATION_MS = 280;
const MAX_SPEECH_DURATION_MS = 12_000;
const PRE_ROLL_MS = 160;
const LEVEL_INTERVAL_MS = 33;

export type HandsFreeCallbacks = {
  onReady?: (microphoneLabel: string) => void;

  onSpeechStart?: () => void;

  onSpeech?: (wav: Blob) => Promise<void> | void;

  onLevel?: (level: number) => void;

  onError?: (error: Error) => void;
};

type MicFrame = {
  samples: Float32Array;
  rms: number;
};

const WORKLET_SOURCE = `
class StarfireMicProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    if (!input || !input[0]) {
      return true;
    }

    const source = input[0];
    const samples = new Float32Array(source.length);

    let sum = 0;

    for (let i = 0; i < source.length; i += 1) {
      const value = source[i];

      samples[i] = value;
      sum += value * value;
    }

    const rms = Math.sqrt(
      sum / Math.max(source.length, 1),
    );

    if (output && output[0]) {
      output[0].set(source);
    }

    this.port.postMessage(
      {
        samples,
        rms,
      },
      [samples.buffer],
    );

    return true;
  }
}

registerProcessor(
  "starfire-mic-processor",
  StarfireMicProcessor,
);
`;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function concatChunks(chunks: Float32Array[]): Float32Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);

  const output = new Float32Array(totalLength);

  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }

  return output;
}

function resample(
  input: Float32Array,
  inputRate: number,
  outputRate: number,
): Float32Array {
  if (inputRate === outputRate || input.length === 0) {
    return input;
  }

  const outputLength = Math.max(
    1,
    Math.round(input.length * (outputRate / inputRate)),
  );

  const output = new Float32Array(outputLength);

  const ratio = inputRate / outputRate;

  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const position = outputIndex * ratio;

    const leftIndex = Math.floor(position);

    const rightIndex = Math.min(leftIndex + 1, input.length - 1);

    const fraction = position - leftIndex;

    const left = input[leftIndex] ?? 0;

    const right = input[rightIndex] ?? left;

    output[outputIndex] = left + (right - left) * fraction;
  }

  return output;
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const bytesPerSample = 2;
  const channels = 1;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;

  const buffer = new ArrayBuffer(44 + dataSize);

  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };

  writeAscii(0, "RIFF");

  view.setUint32(4, 36 + dataSize, true);

  writeAscii(8, "WAVE");

  writeAscii(12, "fmt ");

  view.setUint32(16, 16, true);

  view.setUint16(20, 1, true);

  view.setUint16(22, channels, true);

  view.setUint32(24, sampleRate, true);

  view.setUint32(28, byteRate, true);

  view.setUint16(32, blockAlign, true);

  view.setUint16(34, 16, true);

  writeAscii(36, "data");

  view.setUint32(40, dataSize, true);

  let offset = 44;

  for (let index = 0; index < samples.length; index += 1) {
    const sample = clamp(samples[index], -1, 1);

    const pcm =
      sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);

    view.setInt16(offset, pcm, true);

    offset += 2;
  }

  return new Blob([buffer], {
    type: "audio/wav",
  });
}

function isBadInputLabel(label: string): boolean {
  return /monitor|loopback|stereo mix|output|hdmi|display/i.test(label);
}

async function openBestMicrophone(): Promise<MediaStream> {
  const initialStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });

  const initialTrack = initialStream.getAudioTracks()[0];

  if (!initialTrack) {
    for (const track of initialStream.getTracks()) {
      track.stop();
    }

    throw new Error("No microphone track was created.");
  }

  const devices = await navigator.mediaDevices.enumerateDevices();

  const inputs = devices.filter(
    (device) =>
      device.kind === "audioinput" &&
      device.deviceId !== "default" &&
      device.label.length > 0 &&
      !isBadInputLabel(device.label),
  );

  const currentLabel = initialTrack.label;

  const preferred =
    inputs.find((device) => device.label === currentLabel) ?? inputs[0];

  if (!preferred || preferred.deviceId === "default") {
    return initialStream;
  }

  for (const track of initialStream.getTracks()) {
    track.stop();
  }

  try {
    const selectedStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: {
          exact: preferred.deviceId,
        },
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    return selectedStream;
  } catch {
    console.warn(
      "[Starfire hands-free] Could not reopen preferred microphone; using default input.",
    );

    return await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  }
}

export class HandsFreeListener {
  private readonly callbacks: HandsFreeCallbacks;

  private stream: MediaStream | null = null;

  private audioContext: AudioContext | null = null;

  private source: MediaStreamAudioSourceNode | null = null;

  private worklet: AudioWorkletNode | null = null;

  private silentGain: GainNode | null = null;

  private running = false;
  private paused = false;
  private stopped = false;

  private sampleRate = 48_000;

  private speechActive = false;
  private speechStartedAt = 0;
  private silenceStartedAt = 0;

  private captureChunks: Float32Array[] = [];

  private preRollChunks: Float32Array[] = [];

  private preRollSamples = 0;

  private finishingSpeech = false;

  private lastLevelAt = 0;

  constructor(callbacks: HandsFreeCallbacks) {
    this.callbacks = callbacks;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.stopped = false;

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone API is unavailable.");
    }

    const stream = await openBestMicrophone();

    if (this.stopped) {
      for (const track of stream.getTracks()) {
        track.stop();
      }

      return;
    }

    const track = stream.getAudioTracks()[0];

    if (!track) {
      for (const item of stream.getTracks()) {
        item.stop();
      }

      throw new Error("No microphone track was created.");
    }

    console.log("[Starfire hands-free] 🎤 microphone:", track.label);

    const audioContext = new AudioContext({
      latencyHint: "interactive",
    });

    await audioContext.resume();

    if (this.stopped) {
      await audioContext.close().catch(() => undefined);

      for (const item of stream.getTracks()) {
        item.stop();
      }

      return;
    }

    const source = audioContext.createMediaStreamSource(stream);

    const workletUrl = URL.createObjectURL(
      new Blob([WORKLET_SOURCE], {
        type: "application/javascript",
      }),
    );

    try {
      await audioContext.audioWorklet.addModule(workletUrl);
    } finally {
      URL.revokeObjectURL(workletUrl);
    }

    const worklet = new AudioWorkletNode(
      audioContext,
      "starfire-mic-processor",
      {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
      },
    );

    const silentGain = audioContext.createGain();

    silentGain.gain.value = 0;

    source.connect(worklet);
    worklet.connect(silentGain);
    silentGain.connect(audioContext.destination);

    worklet.port.onmessage = (event: MessageEvent<MicFrame>) => {
      this.handleFrame(event.data);
    };

    this.stream = stream;
    this.audioContext = audioContext;
    this.sampleRate = audioContext.sampleRate;
    this.source = source;
    this.worklet = worklet;
    this.silentGain = silentGain;

    this.running = true;
    this.paused = false;

    console.log("[Starfire hands-free] ✅ ready", {
      sampleRate: this.sampleRate,
    });

    this.callbacks.onReady?.(track.label);
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (!this.stopped) {
      this.paused = false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.running = false;
    this.paused = true;

    this.speechActive = false;
    this.finishingSpeech = false;

    if (this.worklet) {
      this.worklet.disconnect();
    }

    if (this.source) {
      this.source.disconnect();
    }

    if (this.silentGain) {
      this.silentGain.disconnect();
    }

    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
    }

    this.worklet = null;
    this.source = null;
    this.silentGain = null;
    this.stream = null;

    if (this.audioContext) {
      await this.audioContext.close().catch(() => undefined);
    }

    this.audioContext = null;

    this.captureChunks = [];
    this.preRollChunks = [];
    this.preRollSamples = 0;
  }

  private handleFrame(frame: MicFrame): void {
    if (
      !this.running ||
      this.paused ||
      this.stopped ||
      !frame?.samples?.length
    ) {
      return;
    }

    const rms = Number.isFinite(frame.rms) ? frame.rms : 0;

    const now = performance.now();

    if (now - this.lastLevelAt >= LEVEL_INTERVAL_MS) {
      this.lastLevelAt = now;

      this.callbacks.onLevel?.(clamp(rms * 32, 0, 1));
    }

    this.addPreRoll(frame.samples);

    const speaking = rms >= SPEECH_RMS_THRESHOLD;

    if (!this.speechActive) {
      if (!speaking) {
        return;
      }

      this.speechActive = true;
      this.speechStartedAt = now;
      this.silenceStartedAt = 0;

      this.captureChunks = this.preRollChunks.map((chunk) => chunk.slice());

      console.log("[Starfire hands-free] 🎤 speech started");

      this.callbacks.onSpeechStart?.();
    }

    this.captureChunks.push(frame.samples.slice());

    if (speaking) {
      this.silenceStartedAt = 0;
    } else if (this.silenceStartedAt === 0) {
      this.silenceStartedAt = now;
    }

    const speechDuration = now - this.speechStartedAt;

    const silenceDuration =
      this.silenceStartedAt > 0 ? now - this.silenceStartedAt : 0;

    if (
      speechDuration >= MAX_SPEECH_DURATION_MS ||
      silenceDuration >= SILENCE_DURATION_MS
    ) {
      void this.finishSpeech();
    }
  }

  private addPreRoll(samples: Float32Array): void {
    const copy = samples.slice();

    this.preRollChunks.push(copy);
    this.preRollSamples += copy.length;

    const maxSamples = Math.round((this.sampleRate * PRE_ROLL_MS) / 1000);

    while (this.preRollChunks.length > 1 && this.preRollSamples > maxSamples) {
      const removed = this.preRollChunks.shift();

      if (removed) {
        this.preRollSamples -= removed.length;
      }
    }
  }

  private async finishSpeech(): Promise<void> {
    if (this.finishingSpeech || !this.speechActive) {
      return;
    }

    this.finishingSpeech = true;
    this.speechActive = false;
    this.silenceStartedAt = 0;
    this.paused = true;

    const chunks = this.captureChunks;

    this.captureChunks = [];

    const samples = concatChunks(chunks);

    const durationMs = (samples.length / this.sampleRate) * 1000;

    try {
      console.log("[Starfire hands-free] speech ended", {
        durationMs: Math.round(durationMs),
        samples: samples.length,
      });

      if (durationMs < MIN_SPEECH_DURATION_MS) {
        return;
      }

      const resampled = resample(samples, this.sampleRate, TARGET_SAMPLE_RATE);

      const wav = encodeWav(resampled, TARGET_SAMPLE_RATE);

      console.log("[Starfire hands-free] ✅ WAV ready", {
        bytes: wav.size,
        duration: (resampled.length / TARGET_SAMPLE_RATE).toFixed(2),
      });

      await this.callbacks.onSpeech?.(wav);
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error(String(error));

      this.callbacks.onError?.(normalized);
    } finally {
      this.captureChunks = [];
      this.finishingSpeech = false;

      if (!this.stopped) {
        this.paused = false;
      }
    }
  }
}
