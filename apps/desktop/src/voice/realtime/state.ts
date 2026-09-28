export type VoiceStateName =
  | "idle"
  | "starting"
  | "connecting"
  | "listening"
  | "user-speaking"
  | "thinking"
  | "assistant-speaking"
  | "closing"
  | "error";

export type VoiceTransition =
  | { type: "start" }
  | { type: "mic-ready" }
  | { type: "session-ready" }
  | { type: "local-speech-start" }
  | { type: "local-speech-end" }
  | { type: "server-speech-start" }
  | { type: "server-speech-end" }
  | { type: "response-audio" }
  | { type: "response-done" }
  | { type: "interrupted" }
  | { type: "idle-timeout" }
  | { type: "stop" }
  | { type: "fatal-error" }
  | { type: "cleanup-complete" };

export const INITIAL_VOICE_STATE: VoiceStateName = "idle";

function isActive(state: VoiceStateName): boolean {
  return state !== "idle" && state !== "error" && state !== "closing";
}

/*
 * Deterministic transition table. Invalid pairs are no-ops.
 */
export function transitionVoiceState(
  current: VoiceStateName,
  event: VoiceTransition,
): VoiceStateName {
  switch (event.type) {
    case "start":
      return current === "idle" ? "starting" : current;

    case "mic-ready":
      return current === "starting" ? "connecting" : current;

    case "session-ready":
      return current === "starting" || current === "connecting"
        ? "listening"
        : current;

    case "local-speech-start":
    case "server-speech-start":
      return isActive(current) ? "user-speaking" : current;

    case "local-speech-end":
      return current === "user-speaking" ? "listening" : current;

    case "server-speech-end":
      return current === "user-speaking" || current === "listening"
        ? "thinking"
        : current;

    /*
     * Audio can legitimately arrive while the server is still
     * finalizing turn state (fast responses), so assistant audio
     * starts speaking from thinking, listening, or user-speaking.
     */
    case "response-audio":
      return current === "thinking" ||
        current === "listening" ||
        current === "user-speaking"
        ? "assistant-speaking"
        : current;

    case "response-done":
      return current === "assistant-speaking" ||
        current === "thinking" ||
        current === "listening"
        ? "listening"
        : current;

    case "interrupted":
      return current === "assistant-speaking" ? "listening" : current;

    case "idle-timeout":
    case "stop":
      return isActive(current) ? "closing" : current;

    case "fatal-error":
      return isActive(current) ? "error" : current;

    case "cleanup-complete":
      return current === "closing" || current === "error" ? "idle" : current;

    default:
      return current;
  }
}
