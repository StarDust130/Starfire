import { describe, expect, it } from "vitest";

import {
  buildAudioAppend,
  buildFunctionCallOutput,
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

  it("parses a complete function-call event", () => {
    const event = parseServerEvent(
      JSON.stringify({
        type: "response.function_call_arguments.done",

        call_id: "call_abc",

        name: "open_app",

        arguments: JSON.stringify({ app: "vs code" }),
      }),
    );

    expect(event).toEqual({
      kind: "function-call",

      callId: "call_abc",

      name: "open_app",

      args: { app: "vs code" },
    });
  });

  it("malformed arguments JSON becomes a call with null args (registry rejects it)", () => {
    const event = parseServerEvent(
      JSON.stringify({
        type: "response.function_call_arguments.done",

        call_id: "call_abc",

        name: "open_app",

        arguments: "{not json",
      }),
    );

    expect(event?.kind).toBe("function-call");

    if (event?.kind === "function-call") {
      expect(event.args).toBeNull();
    }
  });

  it("function-call without call_id or name degrades to unknown", () => {
    const noId = parseServerEvent(
      JSON.stringify({
        type: "response.function_call_arguments.done",

        name: "open_app",

        arguments: "{}",
      }),
    );

    expect(noId?.kind).toBe("unknown");

    const noName = parseServerEvent(
      JSON.stringify({
        type: "response.function_call_arguments.done",

        call_id: "call_abc",

        arguments: "{}",
      }),
    );

    expect(noName?.kind).toBe("unknown");
  });

  it("function-call with non-object args (number) still parses", () => {
    const event = parseServerEvent(
      JSON.stringify({
        type: "response.function_call_arguments.done",

        call_id: "call_abc",

        name: "open_app",

        arguments: "42",
      }),
    );

    expect(event?.kind).toBe("function-call");

    if (event?.kind === "function-call") {
      expect(event.args).toBe(42);
    }
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

  it("session.update without tools has no tools key", () => {
    const payload = JSON.parse(buildSessionUpdate()) as {
      session: Record<string, unknown>;
    };

    expect("tools" in payload.session).toBe(false);

    expect("tool_choice" in payload.session).toBe(false);
  });

  it("session.update embeds tool manifests and auto tool_choice", () => {
    const payload = JSON.parse(
      buildSessionUpdate([
        {
          type: "function",

          name: "open_app",

          description: "Launch a desktop application.",

          parameters: {
            type: "object",

            properties: {},

            required: ["app"],
          },
        },
      ]),
    ) as { session: { tools: unknown[]; tool_choice: string } };

    expect(payload.session.tool_choice).toBe("auto");

    expect(payload.session.tools).toHaveLength(1);

    expect((payload.session.tools[0] as { name: string }).name).toBe(
      "open_app",
    );
  });

  it("function-call output wraps the result as the protocol expects", () => {
    const message = JSON.parse(
      buildFunctionCallOutput({
        callId: "call_abc",

        ok: true,

        result: { app: "VS Code", pid: 4242 },
      }),
    ) as {
      type: string;

      item: { type: string; call_id: string; output: string };
    };

    expect(message.type).toBe("conversation.item.create");

    expect(message.item.type).toBe("function_call_output");

    expect(message.item.call_id).toBe("call_abc");

    const output = JSON.parse(message.item.output) as Record<string, unknown>;

    expect(output).toEqual({
      ok: true,

      result: { app: "VS Code", pid: 4242 },

      error: null,
    });
  });

  it("function-call output tolerates missing optional fields", () => {
    const message = JSON.parse(
      buildFunctionCallOutput({
        callId: "call_x",

        ok: false,

        error: "I couldn't find that app.",
      }),
    ) as { item: { output: string } };

    const output = JSON.parse(message.item.output) as Record<string, unknown>;

    expect(output).toEqual({
      ok: false,

      result: null,

      error: "I couldn't find that app.",
    });
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
