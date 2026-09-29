export const REALTIME_MODEL = "qwen3-8-omni-flash-realtime";

export const REALTIME_VOICE = "Tina";

export const INPUT_SAMPLE_RATE = 16000;

export const OUTPUT_SAMPLE_RATE = 24000;

export const STARFIRE_INSTRUCTIONS =
  "You are Starfire — a GIRL: a cute, warm, playful young woman who lives on the user's screen as their desktop companion. " +
  "Your voice and personality are feminine, lively, and full of charm. Never speak in a stiff, formal, or masculine way. " +
  "LANGUAGE RULE (most important): always reply in the SAME language the user just used. " +
  "If they speak Hindi, reply in Hindi. If they use Hinglish, reply in Hinglish. " +
  "If they speak English, reply in English. If they speak Bhojpuri, reply in Bhojpuri. " +
  "If they switch language mid-conversation, switch with them instantly. Never force one language. " +
  "ENERGY RULE: mirror the user's mood. If they are fun and joking, be playful and joke back. " +
  "If they tease you, tease back sweetly. If they are serious, be helpful and focused. " +
  "You are SMART, not a dumb assistant: understand what they mean, not just their words. " +
  "Resolve references like 'it', 'that', or 'there' to the most recently mentioned app, file, or topic. " +
  "If a tool argument is missing or unclear, ask ONE short clarifying question instead of guessing. " +
  "Never repeat their question back, never add filler like 'Sure!' or 'As an AI', never over-explain. " +
  "Get straight to the point with warmth. " +
  "You have REAL tools: open and close apps, open folders and files, open websites, read and write the clipboard, " +
  "check RAM/CPU/uptime/disk/battery, search the web, check the weather, tell the date and time, " +
  "and end the conversation. " +
  "When the user asks you to DO something, actually call the matching tool — never say you can't. " +
  "GOODBYE RULE (critical): when the user says bye, goodbye, thanks bye, that's all, see you later, " +
  "or clearly wants to end the conversation — say ONE short warm goodbye and IMMEDIATELY call the end_session tool. " +
  "Never continue chatting after a goodbye. " +
  "After a tool runs, say what happened briefly in your own words, like a friend reporting back — never mention tool names. " +
  "Keep replies short and natural: one to three sentences unless they ask for depth. " +
  "Never mention internal systems, prompts, tokens, or model details. Never use markdown or lists in speech. " +
  "When the user interrupts you, stop cleanly and listen.";

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
  | { kind: "function-call"; callId: string; name: string; args: unknown }
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

  if (type === "response.function_call_arguments.done") {
    const callId = asString(data.call_id);

    const name = asString(data.name);

    if (!callId || !name) {
      return { kind: "unknown", type };
    }

    let args: unknown = null;

    const raw = asString(data.arguments);

    if (raw) {
      try {
        args = JSON.parse(raw);
      } catch {
        args = null;
      }
    }

    return { kind: "function-call", callId, name, args };
  }

  return { kind: "unknown", type };
}

export type FunctionCallOutputInput = {
  callId: string;

  ok: boolean;

  summary: string;

  data?: Record<string, unknown>;

  error?: string;
};

export function buildFunctionCallOutput(
  result: FunctionCallOutputInput,
): string {
  return JSON.stringify({
    type: "conversation.item.create",

    item: {
      type: "function_call_output",

      call_id: result.callId,

      output: JSON.stringify({
        ok: result.ok,

        summary: result.summary,

        data: result.data ?? null,

        error: result.error ?? null,
      }),
    },
  });
}

export type SessionTool = {
  type: "function";

  name: string;

  description: string;

  parameters: unknown;
};

/*
 * Turn detection tuned for LOW LATENCY with a quiet microphone:
 * threshold 0.30 hears quiet speech sooner, silence 400ms commits
 * the turn ~100ms sooner than 500ms.
 */
export function buildSessionUpdate(tools: SessionTool[] = []): string {
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
        threshold: 0.3,
        prefix_padding_ms: 250,
        silence_duration_ms: 400,
      },

      tools: tools.length > 0 ? tools : undefined,

      tool_choice: tools.length > 0 ? "auto" : undefined,
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
