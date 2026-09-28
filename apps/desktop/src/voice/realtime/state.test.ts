import { describe, expect, it } from "vitest";

import {
  INITIAL_VOICE_STATE,
  transitionVoiceState,
  type VoiceStateName,
  type VoiceTransition,
} from "./state";

const events: VoiceTransition[] = [
  { type: "start" },
  { type: "mic-ready" },
  { type: "session-ready" },
  { type: "local-speech-start" },
  { type: "local-speech-end" },
  { type: "server-speech-start" },
  { type: "server-speech-end" },
  { type: "response-audio" },
  { type: "response-done" },
  { type: "interrupted" },
  { type: "idle-timeout" },
  { type: "stop" },
  { type: "fatal-error" },
  { type: "cleanup-complete" },
];

describe("transitionVoiceState", () => {
  it("goes idle -> starting -> connecting -> listening", () => {
    expect(transitionVoiceState("idle", { type: "start" })).toBe("starting");

    expect(transitionVoiceState("starting", { type: "mic-ready" })).toBe(
      "connecting",
    );

    expect(transitionVoiceState("connecting", { type: "session-ready" })).toBe(
      "listening",
    );
  });

  it("activation while active is a no-op", () => {
    expect(transitionVoiceState("listening", { type: "start" })).toBe(
      "listening",
    );

    expect(transitionVoiceState("assistant-speaking", { type: "start" })).toBe(
      "assistant-speaking",
    );
  });

  it("speech events drive the conversation loop", () => {
    expect(
      transitionVoiceState("listening", { type: "server-speech-start" }),
    ).toBe("user-speaking");

    expect(
      transitionVoiceState("user-speaking", { type: "server-speech-end" }),
    ).toBe("thinking");

    expect(transitionVoiceState("thinking", { type: "response-audio" })).toBe(
      "assistant-speaking",
    );

    expect(
      transitionVoiceState("assistant-speaking", { type: "response-done" }),
    ).toBe("listening");
  });

  it("local and server speech can both interrupt the assistant", () => {
    expect(
      transitionVoiceState("assistant-speaking", {
        type: "local-speech-start",
      }),
    ).toBe("user-speaking");

    expect(
      transitionVoiceState("assistant-speaking", {
        type: "server-speech-start",
      }),
    ).toBe("user-speaking");
  });

  it("assistant speech starts from listening, user-speaking, or thinking", () => {
    expect(transitionVoiceState("listening", { type: "response-audio" })).toBe(
      "assistant-speaking",
    );

    expect(
      transitionVoiceState("user-speaking", { type: "response-audio" }),
    ).toBe("assistant-speaking");

    expect(transitionVoiceState("thinking", { type: "response-audio" })).toBe(
      "assistant-speaking",
    );
  });

  it("stop and idle-timeout close from any active state only", () => {
    const active: VoiceStateName[] = [
      "starting",
      "connecting",
      "listening",
      "user-speaking",
      "thinking",
      "assistant-speaking",
    ];

    for (const state of active) {
      expect(transitionVoiceState(state, { type: "stop" })).toBe("closing");

      expect(transitionVoiceState(state, { type: "idle-timeout" })).toBe(
        "closing",
      );
    }

    expect(transitionVoiceState("idle", { type: "stop" })).toBe("idle");

    expect(transitionVoiceState("closing", { type: "stop" })).toBe("closing");
  });

  it("fatal errors come back to idle via cleanup-complete", () => {
    expect(
      transitionVoiceState("assistant-speaking", { type: "fatal-error" }),
    ).toBe("error");

    expect(transitionVoiceState("error", { type: "cleanup-complete" })).toBe(
      "idle",
    );

    expect(transitionVoiceState("closing", { type: "cleanup-complete" })).toBe(
      "idle",
    );
  });

  it("no event can crash on any state (total function)", () => {
    const states: VoiceStateName[] = [
      "idle",
      "starting",
      "connecting",
      "listening",
      "user-speaking",
      "thinking",
      "assistant-speaking",
      "closing",
      "error",
    ];

    for (const state of states) {
      for (const event of events) {
        expect(typeof transitionVoiceState(state, event)).toBe("string");
      }
    }
  });

  it("initial state is idle", () => {
    expect(INITIAL_VOICE_STATE).toBe("idle");
  });

  it("session-ready is accepted from any active state (reconnect path)", () => {
    expect(
      transitionVoiceState("assistant-speaking", { type: "session-ready" }),
    ).toBe("listening");

    expect(
      transitionVoiceState("user-speaking", { type: "session-ready" }),
    ).toBe("listening");

    expect(transitionVoiceState("listening", { type: "session-ready" })).toBe(
      "listening",
    );

    expect(transitionVoiceState("idle", { type: "session-ready" })).toBe(
      "idle",
    );
  });
});
