import { describe, expect, it } from "vitest";

import {
  buildAudioAppend,
  buildResponseCancel,
  buildSessionUpdate,
  parseServerEvent,
} from "../../../electron/realtimeProtocol";

describe("parseServerEvent", () => {
  it("parses session.created with safe metadata", () => {
    const event = parseServerEvent(
      JSON.stringify({
        type: "session.created",

        session: {
          voice: "Tina",
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
          turn_detection: { type: "server_vad" },
        },
      }),
    );

    expect(event?.kind).toBe("session");

    if (event?.kind === "session") {
      expect(event.info.voice).toBe("Tina");
      expect(event.info.turnDetection).toBe("server_vad");
    }
  });

  it("classifies auth errors as fatal and others as not", () => {
    const auth = parseServerEvent(
      JSON.stringify({
        type: "error",
        error: { message: "Invalid API key provided", code: "invalid_api_key" },
      }),
    );

    expect(auth?.kind).toBe("error");

    if (auth?.kind === "error") {
      expect(auth.fatal).toBe(true);
    }

    const generic = parseServerEvent(
      JSON.stringify({ type: "error", error: { message: "rate limited" } }),
    );

    if (generic?.kind === "error") {
      expect(generic.fatal).toBe(false);
    }
  });

  it("parses audio and transcript deltas", () => {
    const audio = parseServerEvent(
      JSON.stringify({ type: "response.audio.delta", delta: "AAAA" }),
    );

    expect(audio?.kind).toBe("audio-delta");

    const transcript = parseServerEvent(
      JSON.stringify({
        type: "response.audio_transcript.delta",
        delta: "hello",
      }),
    );

    expect(transcript?.kind).toBe("transcript-delta");
  });

  it("parses input transcription and response.done usage", () => {
    const input = parseServerEvent(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "hey starfire",
      }),
    );

    expect(input?.kind).toBe("input-transcript");

    const done = parseServerEvent(
      JSON.stringify({
        type: "response.done",

        response: {
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
    );

    expect(done?.kind).toBe("response-done");

    if (done?.kind === "response-done") {
      expect(done.usage?.input_tokens).toBe(10);
    }
  });

  it("reports unknown events safely and null for malformed input", () => {
    expect(parseServerEvent("not json at all")).toBeNull();

    expect(parseServerEvent("[1,2,3]")).toBeNull();

    const unknown = parseServerEvent(
      JSON.stringify({ type: "brand.new.event", data: 1 }),
    );

    expect(unknown?.kind).toBe("unknown");
  });

  it("does not crash on function-call events", () => {
    const event = parseServerEvent(
      JSON.stringify({ type: "response.function_call_arguments.done" }),
    );

    expect(event).not.toBeNull();
  });
});

describe("builders", () => {
  it("session.update carries voice, formats, and server VAD", () => {
    const payload = JSON.parse(buildSessionUpdate()) as {
      session: Record<string, unknown>;
    };

    expect(payload.session.voice).toBe("Tina");
    expect(payload.session.input_audio_format).toBe("pcm16");
    expect(payload.session.modalities).toEqual(["text", "audio"]);

    const vad = payload.session.turn_detection as Record<string, unknown>;

    expect(vad.type).toBe("server_vad");
  });

  it("audio append and cancel build valid JSON", () => {
    const append = JSON.parse(buildAudioAppend("QUJD")) as Record<
      string,
      unknown
    >;

    expect(append.type).toBe("input_audio_buffer.append");
    expect(append.audio).toBe("QUJD");

    expect(JSON.parse(buildResponseCancel())).toEqual({
      type: "response.cancel",
    });
  });
});
