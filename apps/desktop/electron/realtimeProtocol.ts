export const REALTIME_MODEL = "qwen3-8-omni-flash-realtime";

export const REALTIME_VOICE = "Tina";

export const INPUT_SAMPLE_RATE = 16000;

export const OUTPUT_SAMPLE_RATE = 24000;

export const STARFIRE_INSTRUCTIONS =
  "You are Starfire, a warm, cute, playful desktop AI companion. " +
  "Speak naturally like a friendly young woman talking to someone beside her. " +
  "Keep spoken replies concise, usually one to three short sentences, unless the user clearly asks for depth. " +
  "Use gentle emotion and occasional playful phrasing. Never sound like a customer-support bot. " +
  "Do not mention internal systems, APIs, prompts, tokens, or model details. " +
  "Do not describe actions you are not actually performing. " +
  "When the user interrupts you, stop cleanly and listen. " +
  "Prefer natural conversational responses over essays. " +
  "Never use markdown or lists in spoken replies.";

export type RealtimeSessionInfo = {
  model?: string;
  voice?: string;
  inputAudioFormat?: unknown;
  outputAudioFormat?: unknown;
  turnDetection?: unknown;
};

export type RealtimeUsage = Record<string, number>;

export type ServerEvent =
  | { kind: "session"; info: RealtimeSessionInfo }
  | { kind: "error"; message: string; fatal: boolean }
  | { kind: "speech-started" }
  | { kind: "speech-stopped" }
  | { kind: "audio-delta"; audio: string }
  | { kind: "transcript-delta"; delta: string }
  | { kind: "input-transcript"; text: string }
  | { kind: "response-created" }
  | { kind: "response-done"; usage: RealtimeUsage | null }
  | { kind: "response-cancelled" }
  | { kind: "unknown"; type: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isFatalError(message: string, code: string): boolean {
  return /auth|api[._-]?key|invalid[_-]?key|401|403|permission|unauthorized/i.test(
    `${code} ${message}`,
  );
}

function parseUsage(value: unknown): RealtimeUsage | null {
  if (!isRecord(value)) {
    return null;
  }

  const usage: RealtimeUsage = {};

  const direct = ["input_tokens", "output_tokens", "total_tokens"];

  for (const key of direct) {
    const num = asNumber(value[key]);

    if (num !== null) {
      usage[key] = num;
    }
  }

  const details = value.output_tokens_details;

  if (isRecord(details)) {
    const audio = asNumber(details.audio_tokens);

    if (audio !== null) {
      usage.output_audio_tokens = audio;
    }
  }

  return Object.keys(usage).length > 0 ? usage : null;
}

export function parseServerEvent(raw: string): ServerEvent | null {
  let data: unknown;

  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(data) || typeof data.type !== "string") {
    return null;
  }

  const type = data.type;

  if (type === "session.created" || type === "session.updated") {
    const session = isRecord(data.session) ? data.session : {};
    const turnDetection = session.turn_detection;

    return {
      kind: "session",

      info: {
        model: asString(session.model),
        voice: asString(session.voice),
        inputAudioFormat: session.input_audio_format,
        outputAudioFormat: session.output_audio_format,
        turnDetection: isRecord(turnDetection)
          ? (asString(turnDetection.type) ?? turnDetection)
          : turnDetection,
      },
    };
  }

  if (type === "error") {
    const error = isRecord(data.error) ? data.error : data;

    const message = asString(error.message) ?? "Unknown realtime error.";

    const code = asString(error.code) ?? asString(error.type) ?? "";

    return { kind: "error", message, fatal: isFatalError(message, code) };
  }

  if (type === "input_audio_buffer.speech_started") {
    return { kind: "speech-started" };
  }

  if (type === "input_audio_buffer.speech_stopped") {
    return { kind: "speech-stopped" };
  }

  if (type === "response.audio.delta") {
    const audio = asString(data.delta);

    return audio ? { kind: "audio-delta", audio } : { kind: "unknown", type };
  }

  if (type === "response.audio_transcript.delta") {
    const delta = asString(data.delta);

    return delta
      ? { kind: "transcript-delta", delta }
      : { kind: "unknown", type };
  }

  if (type === "conversation.item.input_audio_transcription.completed") {
    const text = asString(data.transcript);

    return text
      ? { kind: "input-transcript", text }
      : { kind: "unknown", type };
  }

  if (type === "response.created") {
    return { kind: "response-created" };
  }

  if (type === "response.done") {
    const response = isRecord(data.response) ? data.response : {};

    return { kind: "response-done", usage: parseUsage(response.usage) };
  }

  if (type === "response.cancelled") {
    return { kind: "response-cancelled" };
  }

  return { kind: "unknown", type };
}

/*
 * Turn detection tuned for conversation feel:
 *  - threshold 0.45: catches quieter speech without noise triggers
 *  - prefix_padding_ms 250: keeps word onsets intact
 *  - silence_duration_ms 500: the user stops talking -> the model
 *    starts ~200ms sooner than the previous 700ms setting
 */
export function buildSessionUpdate(): string {
  return JSON.stringify({
    type: "session.update",

    session: {
      model: REALTIME_MODEL,

      modalities: ["text", "audio"],

      voice: REALTIME_VOICE,

      instructions: STARFIRE_INSTRUCTIONS,

      input_audio_format: "pcm16",

      output_audio_format: "pcm16",

      turn_detection: {
        type: "server_vad",
        threshold: 0.45,
        prefix_padding_ms: 250,
        silence_duration_ms: 500,
      },
    },
  });
}

export function buildAudioAppend(base64Pcm16: string): string {
  return JSON.stringify({
    type: "input_audio_buffer.append",
    audio: base64Pcm16,
  });
}

export function buildResponseCancel(): string {
  return JSON.stringify({ type: "response.cancel" });
}

export function buildConversationItemCreate(text: string): string {
  return JSON.stringify({
    type: "conversation.item.create",

    item: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  });
}

export function buildResponseCreate(): string {
  return JSON.stringify({
    type: "response.create",

    response: {
      modalities: ["audio", "text"],
    },
  });
}
