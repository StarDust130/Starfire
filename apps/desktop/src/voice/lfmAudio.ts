const LFM_BASE_URL = "http://127.0.0.1:8080/v1";

const LFM_SYSTEM_PROMPT = "Respond with interleaved text and audio.";

const STARFIRE_PERSONA = `
You are Starfire, a cute female desktop AI companion.
Be warm, natural, playful, and concise.
Speak naturally like a real conversational companion.
Answer the user's spoken request directly.
Do not give long speeches unless the user asks.
`.trim();

const OUTPUT_SAMPLE_RATE = 24_000;
const MAX_TOKENS = 256;
const LEVEL_INTERVAL_MS = 33;

type AudioSamples = Float32Array<ArrayBufferLike>;

type StreamCallbacks = {
  onText?: (text: string) => void;
  onAudioStart?: () => void;
  onAudioLevel?: (level: number) => void;
};

type AudioChunk =
  | string
  | {
      data?: string;
    }
  | null
  | undefined;

type Delta = {
  content?: string | null;
  audio_chunk?: AudioChunk;
};

type StreamChoice = {
  delta?: Delta;
  finish_reason?: string | null;
};

type StreamChunk = {
  choices?: StreamChoice[];
};

let firstTurn = true;

let audioContext: AudioContext | null = null;

let nextPlaybackTime = 0;

let lastLevelAt = 0;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);

  let binary = "";

  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(
      offset,
      Math.min(offset + chunkSize, bytes.length),
    );

    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function decodeFloat32(base64: string): AudioSamples {
  const binary = atob(base64);

  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  const sampleCount = Math.floor(bytes.byteLength / 4);

  const view = new DataView(bytes.buffer);

  const samples = new Float32Array(sampleCount);

  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = view.getFloat32(index * 4, true);
  }

  return samples;
}

function calculateRms(samples: AudioSamples): number {
  if (!samples.length) {
    return 0;
  }

  let sum = 0;

  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] ?? 0;

    sum += sample * sample;
  }

  return Math.sqrt(sum / samples.length);
}

async function getAudioContext(): Promise<AudioContext> {
  if (!audioContext) {
    audioContext = new AudioContext({
      latencyHint: "interactive",
    });
  }

  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  return audioContext;
}

function scheduleAudioChunk(
  samples: AudioSamples,
  callbacks: StreamCallbacks,
): void {
  if (!audioContext || samples.length === 0) {
    return;
  }

  const context = audioContext;

  const audioBuffer = context.createBuffer(
    1,
    samples.length,
    OUTPUT_SAMPLE_RATE,
  );

  audioBuffer.getChannelData(0).set(samples);

  const source = context.createBufferSource();

  source.buffer = audioBuffer;

  source.connect(context.destination);

  const startTime = Math.max(context.currentTime + 0.02, nextPlaybackTime);

  source.start(startTime);

  nextPlaybackTime = startTime + audioBuffer.duration;

  const level = clamp(calculateRms(samples) * 5, 0, 1);

  const delay = Math.max(0, (startTime - context.currentTime) * 1000);

  const startTimeout = Math.max(0, Math.ceil(delay));

  window.setTimeout(() => {
    const now = performance.now();

    if (now - lastLevelAt < LEVEL_INTERVAL_MS) {
      return;
    }

    lastLevelAt = now;

    callbacks.onAudioLevel?.(level);
  }, startTimeout);

  window.setTimeout(
    () => {
      callbacks.onAudioLevel?.(0);
    },
    startTimeout + Math.ceil(audioBuffer.duration * 1000),
  );
}

async function waitForPlayback(): Promise<void> {
  if (!audioContext) {
    return;
  }

  const remaining = nextPlaybackTime - audioContext.currentTime;

  if (remaining <= 0) {
    return;
  }

  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, Math.ceil(remaining * 1000) + 80);
  });
}

function getAudioData(delta: Delta): string | null {
  const chunk = delta.audio_chunk;

  if (!chunk) {
    return null;
  }

  if (typeof chunk === "string") {
    return chunk;
  }

  return chunk.data ?? null;
}

export async function speakWithLfm(
  wav: Blob,
  callbacks: StreamCallbacks = {},
): Promise<string> {
  const context = await getAudioContext();

  if (context.currentTime > nextPlaybackTime) {
    nextPlaybackTime = context.currentTime;
  }

  const wavBuffer = await wav.arrayBuffer();

  const encodedAudio = arrayBufferToBase64(wavBuffer);

  const messages: Array<{
    role: string;
    content: unknown;
  }> = [];

  const resetContext = firstTurn;

  if (firstTurn) {
    messages.push({
      role: "system",
      content: LFM_SYSTEM_PROMPT,
    });

    messages.push({
      role: "user",
      content: STARFIRE_PERSONA,
    });
  }

  messages.push({
    role: "user",
    content: [
      {
        type: "input_audio",
        input_audio: {
          data: encodedAudio,
          format: "wav",
        },
      },
    ],
  });

  console.log("[Starfire LFM] 🎤 sending audio", {
    bytes: wav.size,
    resetContext,
  });

  const response = await fetch(`${LFM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "",
      messages,
      stream: true,
      max_tokens: MAX_TOKENS,
      extra_body: {
        reset_context: resetContext,
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();

    throw new Error(`LFM HTTP ${response.status}: ${body}`);
  }

  if (!response.body) {
    throw new Error("LFM returned no streaming body.");
  }

  console.log("[Starfire LFM] ✅ HTTP", response.status);

  firstTurn = false;

  const reader = response.body.getReader();

  const decoder = new TextDecoder();

  let buffer = "";
  let fullText = "";
  let gotAudio = false;

  try {
    while (true) {
      const result = await reader.read();

      if (result.done) {
        break;
      }

      buffer += decoder.decode(result.value, {
        stream: true,
      });

      const events = buffer.split(/\r?\n\r?\n/);

      buffer = events.pop() ?? "";

      for (const event of events) {
        const lines = event.split(/\r?\n/);

        for (const line of lines) {
          if (!line.startsWith("data:")) {
            continue;
          }

          const payload = line.slice(5).trim();

          if (!payload || payload === "[DONE]") {
            continue;
          }

          let chunk: StreamChunk;

          try {
            chunk = JSON.parse(payload) as StreamChunk;
          } catch {
            continue;
          }

          const choice = chunk.choices?.[0];

          if (!choice) {
            continue;
          }

          const delta = choice.delta;

          if (delta?.content) {
            fullText += delta.content;

            callbacks.onText?.(delta.content);
          }

          if (!delta) {
            continue;
          }

          const audioData = getAudioData(delta);

          if (!audioData) {
            continue;
          }

          if (!gotAudio) {
            gotAudio = true;

            callbacks.onAudioStart?.();

            console.log("[Starfire LFM] 🔊 first audio chunk");
          }

          const samples = decodeFloat32(audioData);

          scheduleAudioChunk(samples, callbacks);
        }
      }
    }

    buffer += decoder.decode();

    await waitForPlayback();

    callbacks.onAudioLevel?.(0);

    console.log("[Starfire LFM] ✅ finished", {
      text: fullText,
      audio: gotAudio,
    });

    return fullText;
  } catch (error) {
    firstTurn = true;
    throw error;
  }
}
