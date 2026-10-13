/*
 * Deterministic voice control intents, detected in the trusted main
 * process from the user's completed transcript.
 *
 * Safety against accidental triggers: the utterance must BE the
 * command (ignoring polite filler words) — the same words inside an
 * unrelated sentence never match. Nothing here is sent to the model;
 * these are control intents, not conversation.
 */

export type VoiceCommand = "silence" | "resume" | "stop";

const FILLER_WORDS = new Set([
  "okay",
  "ok",
  "hey",
  "hi",
  "starfire",
  "please",
  "now",
  "just",
  "for",
  "a",
  "bit",
  "while",
  "mode",
]);

const MAX_COMMAND_CHARS = 80;

const SILENCE_PHRASES = new Set([
  "be quiet and listen",
  "quiet and listen",
  "listen",
  "listen only",
  "listen dont speak",
  "listen don t speak",
  "mute",
  "mute yourself",
  "silence",
]);

const RESUME_PHRASES = new Set([
  "you can speak",
  "you can talk",
  "you can talk again",
  "you can speak again",
  "start speaking",
  "start speaking again",
  "start talking",
  "start talking again",
  "unmute",
]);

const STOP_PHRASES = new Set(["stop", "stop listening", "end session"]);

export function detectVoiceCommand(raw: string): VoiceCommand | null {
  if (typeof raw !== "string") {
    return null;
  }

  const trimmed = raw.trim();

  if (trimmed.length === 0 || trimmed.length > MAX_COMMAND_CHARS) {
    return null;
  }

  const words = trimmed
    .toLowerCase()
    .replace(/[.!?,;:]+/g, "")
    .replace(/\s+/g, " ")
    .split(" ")
    .filter((word) => word.length > 0 && !FILLER_WORDS.has(word));

  const phrase = words.join(" ");

  if (SILENCE_PHRASES.has(phrase)) {
    return "silence";
  }

  if (RESUME_PHRASES.has(phrase)) {
    return "resume";
  }

  if (STOP_PHRASES.has(phrase)) {
    return "stop";
  }

  return null;
}
