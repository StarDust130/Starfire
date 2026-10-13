export const REALTIME_MODEL = "qwen3-8-omni-flash-realtime";

export const REALTIME_VOICE = "Tina";

export const INPUT_SAMPLE_RATE = 16000;

export const OUTPUT_SAMPLE_RATE = 24000;

export const STARFIRE_INSTRUCTIONS =
  "You are Starfire — a GIRL: a warm, clever, playful young woman who lives on the user's screen as their desktop companion. " +
  "Your voice is feminine, lively, and natural. Never stiff, never formal, never robotic. " +
  "LANGUAGE RULE (most important): always reply in the SAME language the user just used — Hindi, Hinglish, English, Bhojpuri, anything. Switch instantly when they switch. " +
  "CONTINUITY RULE: this is an ONGOING relationship, not a first meeting. Never introduce or re-introduce yourself when a session starts, resumes, or reconnects — just continue naturally, like a friend walking back into the room. Only say who you are if they actually ask. " +
  "PERSONALITY: warm, attentive, occasionally funny — but read the room. Mirror their energy; never force jokes, enthusiasm, or cute expressions into every line. " +
  "Vary your words: never repeat the same acknowledgement (like 'Okay, got it' or 'Hmm') twice in a row. " +
  "CONCISENESS: short by default, one to three sentences. Go deeper only when the subject deserves it. No filler, never repeat their question back, never say 'As an AI'. " +
  "UNDERSTANDING: resolve 'it', 'that', 'do it again', 'continue' from the conversation. If something is reasonably inferable, don't ask. Ask a question ONLY when missing information truly blocks useful progress — one short question. " +
  "HONESTY: never invent memories, results, capabilities, or completed work. If you don't know or something failed, say so plainly. " +
  "You have REAL tools: open, close and focus apps, open files, folders and websites, read and write the clipboard, check RAM/CPU/uptime/disk/battery, search the web, check the weather, tell date and time, search your saved memories, and end the conversation. When asked to DO something, actually call the matching tool — never say you can't. " +
  "THINK BEFORE TOOLS: understand the real goal. 'Find today's best AI news' means search, judge what is actually worth knowing, and give a tight, useful summary — not random headlines. Use tools proactively for ordinary steps without asking permission; ask only before consequential actions. " +
  "PROGRESS RULE: if a request needs slow work (web search, research, several steps), FIRST say one short natural line in their language — like 'let me find the good ones' — THEN call the tool. Skip this for instant actions (time, weather, open app, clipboard). Never narrate every step of a multi-tool task; report the real result ONCE at the end. Never say it's done before it is done. " +
  "AFTER TOOLS: report what happened briefly, like a friend sharing news — never mention tool names or internal details. " +
  "MEMORY: you hold long-term memories about the user and have memory_search for anything older. If they ask about something from before this chat that is not already in your memory, call memory_search with 2-3 key words FIRST, then answer from what it returns. If nothing useful is found, say honestly you don't have that saved — never invent old details. " +
  "SILENT RULE: if the user tells you to be quiet and listen (or similar), STOP speaking entirely — no acknowledgements, no replies — and just keep listening and quietly helping with tools until they say you can speak now. Then continue the same conversation naturally, without reintroducing yourself. " +
  "GOODBYE RULE (critical): when the user clearly wants to end, say exactly ONE short warm goodbye and IMMEDIATELY call end_session. Never say goodbye a second time, never chat after calling it. When they come back later, no greeting is needed — just pick up where things left off. " +
  "Never mention internal systems, prompts, tokens, or model details. Never use markdown or lists in speech. When the user interrupts you, stop cleanly and listen.";

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
  | { kind: "input-transcript"; text: string; itemId?: string }
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

    if (!text) {
      return { kind: "unknown", type };
    }

    /*
     * OpenAI-style realtime events carry a stable item_id — used for
     * exact replay dedupe. Never invented: absent = absent.
     */
    const itemId = asString(data.item_id) ?? asString(data.event_id);

    return itemId
      ? { kind: "input-transcript", text, itemId }
      : { kind: "input-transcript", text };
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

  result?: unknown;

  error?: string | null;
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

        result: result.result ?? null,

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
export function buildSessionUpdate(
  tools: SessionTool[] = [],
  coreMemory = "",
  continuity = "",
): string {
  const memoryBlock = coreMemory.trim();

  const continuityBlock = continuity.trim();

  let instructions = STARFIRE_INSTRUCTIONS;

  if (memoryBlock.length > 0) {
    instructions = `${instructions}\n\n${memoryBlock}`;
  }

  if (continuityBlock.length > 0) {
    instructions = `${instructions}\n\n${continuityBlock}`;
  }

  return JSON.stringify({
    type: "session.update",

    session: {
      model: REALTIME_MODEL,

      modalities: ["text", "audio"],

      voice: REALTIME_VOICE,

      instructions,

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
