import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaybackPipeline } from "./controller";
import {
  VOICE_IDLE_AFTER_RESPONSE_MS,
  type VoiceBridge,
  VoiceController,
  type VoiceRendererEvent,
} from "./controller";
import type { MicPipeline, MicVariant } from "./microphone";

type EmitEvent = (event: VoiceRendererEvent) => void;

type EmitChunk = (rms: number) => void;

function makeDeps() {
  const order: string[] = [];

  let emitEvent: EmitEvent = () => {};

  let emitChunk: EmitChunk = () => {};

  let emitDrained: () => void = () => {};

  const bridge: VoiceBridge = {
    start: vi.fn(async () => ({ ok: true as const, conn: 1 })),

    sendAudio: vi.fn(() => {}),

    interrupt: vi.fn(() => {}),

    stop: vi.fn(() => {}),

    onEvent: vi.fn((callback: (event: VoiceRendererEvent) => void) => {
      emitEvent = callback;

      return () => {};
    }),

    onAudio: vi.fn((_callback: (pcm: ArrayBuffer) => void) => {
      return () => {};
    }),
  };

  const mic: MicPipeline = {
    start: vi.fn(async () => {
      order.push("mic");

      return 16000;
    }),

    stop: vi.fn(async () => {}),
  };

  const playback: PlaybackPipeline = {
    warmup: vi.fn(async () => {}),

    push: vi.fn(() => {}),

    clear: vi.fn(() => {}),

    stop: vi.fn(async () => {}),
  };

  const deps = {
    bridge,

    micStallTimeoutMs: 60000,

    getDeviceId: vi.fn(() => "device-1"),

    createMic: vi.fn(
      (
        handlers: {
          onChunk: (chunk: { samples: Float32Array; rms: number }) => void;

          onDiagnostic?: (message: string) => void;
        },
        variant: MicVariant,
        deviceId?: string,
      ) => {
        order.push("createMic");

        emitChunk = (rms: number) => {
          handlers.onChunk({ samples: new Float32Array(320), rms });
        };

        order.push(
          `variant:${variant.processing ? "on" : "off"}:` +
            `${variant.useDeviceId && deviceId ? "id" : "default"}`,
        );

        return mic;
      },
    ),

    createPlayback: vi.fn((handlers: { onDrained?: () => void }) => {
      emitDrained = handlers.onDrained ?? (() => {});

      return playback;
    }),

    onStopWakeEngine: vi.fn(async () => {
      order.push("wake-stop");
    }),

    onStartWakeEngine: vi.fn(() => {
      order.push("wake-start");
    }),
  };

  return {
    deps,
    bridge,
    mic,
    playback,
    order,

    emitEvent: (event: VoiceRendererEvent) => emitEvent(event),

    emitChunk: (rms: number) => emitChunk(rms),

    emitDrained: () => emitDrained(),

    onAudioCall: (): ((pcm: ArrayBuffer) => void) => {
      const call = (bridge.onAudio as ReturnType<typeof vi.fn>).mock
        .calls[0][0];

      return call as (pcm: ArrayBuffer) => void;
    },
  };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("VoiceController", () => {
  it("1. idle -> starting on activation", async () => {
    const { deps } = makeDeps();

    const controller = new VoiceController(deps);

    void controller.start();

    await flush();

    expect(controller.getState().state).toBe("listening");
  });

  it("2-3. duplicate activation ignored; one socket/mic only", async () => {
    const { deps, bridge } = makeDeps();

    const controller = new VoiceController(deps);

    void controller.start();

    await flush();

    await controller.start();

    expect(bridge.start).toHaveBeenCalledTimes(1);

    expect(deps.createMic).toHaveBeenCalledTimes(1);
  });

  it("connect retries once on transient failure", async () => {
    const { deps, bridge } = makeDeps();

    bridge.start = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: "Realtime connection timed out.",
        fatal: false,
      })
      .mockResolvedValueOnce({ ok: true, conn: 1 });

    const controller = new VoiceController(deps);

    void controller.start();

    await vi.advanceTimersByTimeAsync(500);

    expect(bridge.start).toHaveBeenCalledTimes(2);

    expect(controller.getState().state).toBe("listening");
  });

  it("auth failures never retry", async () => {
    const { deps, bridge } = makeDeps();

    bridge.start = vi.fn(async () => ({
      ok: false as const,
      error: "EmpirioLabs API key is not configured.",
      fatal: true,
    }));

    const controller = new VoiceController(deps);

    void controller.start();

    await flush();

    expect(bridge.start).toHaveBeenCalledTimes(1);

    expect(controller.getState().state).toBe("error");
  });

  it("unexpected close mid-conversation auto-reconnects once", async () => {
    const { deps, bridge, emitEvent, onAudioCall } = makeDeps();

    const controller = new VoiceController(deps);

    void controller.start();

    await flush();

    onAudioCall()(new ArrayBuffer(64));

    expect(controller.getState().state).toBe("assistant-speaking");

    emitEvent({ conn: 1, kind: "closed" });

    await vi.advanceTimersByTimeAsync(800);

    expect(bridge.start).toHaveBeenCalledTimes(2);

    expect(controller.getState().state).toBe("listening");

    expect(deps.onStartWakeEngine).not.toHaveBeenCalled();
  });

  it("a second unexpected close gives up cleanly and restores wake", async () => {
    const { deps, emitEvent } = makeDeps();

    const controller = new VoiceController(deps);

    void controller.start();

    await flush();

    emitEvent({ conn: 1, kind: "closed" });

    await vi.advanceTimersByTimeAsync(800);

    expect(controller.getState().state).toBe("listening");

    emitEvent({ conn: 1, kind: "closed" });

    expect(controller.getState().message).toContain("closed");

    await vi.advanceTimersByTimeAsync(500);

    expect(controller.getState().state).toBe("idle");

    expect(deps.onStartWakeEngine).toHaveBeenCalled();
  });

  it("first capture attempt uses the wake engine's device", async () => {
    const { deps } = makeDeps();

    const controller = new VoiceController(deps);

    void controller.start();

    await flush();

    expect(deps.createMic).toHaveBeenCalledTimes(1);

    expect(deps.createMic.mock.calls[0][1]).toEqual({
      processing: true,
      useDeviceId: true,
    });

    expect(deps.createMic.mock.calls[0][2]).toBe("device-1");
  });

  it("4. missing API key fails cleanly and recovers", async () => {
    const { deps, bridge } = makeDeps();

    bridge.start = vi.fn(async () => ({
      ok: false as const,
      error: "EmpirioLabs API key is not configured.",
      fatal: true,
    }));

    const controller = new VoiceController(deps);

    void controller.start();

    await flush();

    expect(controller.getState().state).toBe("error");

    expect(controller.getState().message).toContain("not configured");

    await vi.advanceTimersByTimeAsync(400);

    expect(controller.getState().state).toBe("idle");

    expect(deps.onStartWakeEngine).toHaveBeenCalled();
  });

  it("echo below the floor is not uploaded while she speaks", async () => {
    const { deps, bridge, emitChunk, onAudioCall } = makeDeps();

    const controller = new VoiceController(deps);

    void controller.start();

    await flush();

    onAudioCall()(new ArrayBuffer(64));

    expect(controller.getState().state).toBe("assistant-speaking");

    for (let i = 0; i < 10; i += 1) {
      emitChunk(0.01);
    }

    expect(bridge.sendAudio).not.toHaveBeenCalled();

    expect(controller.getState().state).toBe("assistant-speaking");
  });

  it("real speech above the floor is uploaded while she speaks (server VAD can interrupt)", async () => {
    const { deps, bridge, playback, emitChunk, onAudioCall } = makeDeps();

    const controller = new VoiceController(deps);

    void controller.start();

    await flush();

    onAudioCall()(new ArrayBuffer(64));

    emitChunk(0.01);

    expect(bridge.sendAudio).not.toHaveBeenCalled();

    emitChunk(0.2);

    expect(bridge.sendAudio).toHaveBeenCalled();

    expect(playback.clear).not.toHaveBeenCalled();
  });

  it("sustained loud speech triggers the local fallback interrupt", async () => {
    const { deps, playback, bridge, emitChunk, onAudioCall } = makeDeps();

    const controller = new VoiceController(deps);

    void controller.start();

    await flush();

    onAudioCall()(new ArrayBuffer(64));

    expect(controller.getState().state).toBe("assistant-speaking");

    for (let i = 0; i < 20; i += 1) {
      emitChunk(0.2);
    }

    expect(playback.clear).toHaveBeenCalled();

    expect(bridge.interrupt).toHaveBeenCalled();
  });

  it("sustained echo-level audio does NOT trigger the local fallback", async () => {
    const { deps, playback, bridge, emitChunk, onAudioCall } = makeDeps();

    const controller = new VoiceController(deps);

    void controller.start();

    await flush();

    onAudioCall()(new ArrayBuffer(64));

    for (let i = 0; i < 40; i += 1) {
      emitChunk(0.05);
    }

    expect(playback.clear).not.toHaveBeenCalled();

    expect(bridge.interrupt).not.toHaveBeenCalled();
  });

  it("response-done waits for playback drain before listening", async () => {
    const { deps, emitEvent, onAudioCall, emitDrained } = makeDeps();

    const controller = new VoiceController(deps);

    void controller.start();

    await flush();

    emitEvent({ conn: 1, kind: "speech-started" });

    emitEvent({ conn: 1, kind: "speech-stopped" });

    onAudioCall()(new ArrayBuffer(48 * 400));

    expect(controller.getState().state).toBe("assistant-speaking");

    emitEvent({ conn: 1, kind: "response-done", usage: null });

    expect(controller.getState().state).toBe("assistant-speaking");

    emitDrained();

    expect(controller.getState().state).toBe("listening");
  });

  it("post-response echo cooldown blocks phantom turns, real speech passes", async () => {
    const { deps, bridge, emitChunk, emitEvent } = makeDeps();

    const controller = new VoiceController(deps);

    void controller.start();

    await flush();

    emitEvent({ conn: 1, kind: "response-done", usage: null });

    expect(controller.getState().state).toBe("listening");

    for (let i = 0; i < 20; i += 1) {
      emitChunk(0.01);
    }

    expect(bridge.sendAudio).not.toHaveBeenCalled();

    expect(controller.getState().state).toBe("listening");

    await vi.advanceTimersByTimeAsync(1600);

    emitChunk(0.0005);

    expect(bridge.sendAudio).not.toHaveBeenCalled();

    expect(controller.getState().state).toBe("listening");

    emitChunk(0.3);

    expect(controller.getState().state).toBe("user-speaking");
  });

  it("7. transcript deltas accumulate", async () => {
    const { deps, emitEvent } = makeDeps();

    const controller = new VoiceController(deps);

    void controller.start();

    await flush();

    emitEvent({ conn: 1, kind: "audio-transcript-delta", delta: "Hi " });

    emitEvent({ conn: 1, kind: "audio-transcript-delta", delta: "there" });

    expect(controller.transcript.assistant).toBe("Hi there");
  });

  it("8+12. response.done returns to listening, then idle timeout closes", async () => {
    const { deps, emitEvent } = makeDeps();

    const controller = new VoiceController(deps);

    void controller.start();

    await flush();

    emitEvent({ conn: 1, kind: "response-done", usage: null });

    expect(controller.getState().state).toBe("listening");

    await vi.advanceTimersByTimeAsync(VOICE_IDLE_AFTER_RESPONSE_MS - 100);

    expect(controller.getState().state).toBe("listening");

    await vi.advanceTimersByTimeAsync(200);

    expect(controller.getState().state).toBe("closing");

    await vi.advanceTimersByTimeAsync(500);

    expect(controller.getState().state).toBe("idle");
  });

  it("13. user speech cancels the idle timeout", async () => {
    const { deps, emitChunk, emitEvent } = makeDeps();

    const controller = new VoiceController(deps);

    void controller.start();

    await flush();

    emitEvent({ conn: 1, kind: "response-done", usage: null });

    emitChunk(0.4);

    await vi.advanceTimersByTimeAsync(VOICE_IDLE_AFTER_RESPONSE_MS + 500);

    expect(controller.getState().state).toBe("user-speaking");
  });

  it("10-11. stale events and audio from old sessions are ignored", async () => {
    const { deps, playback, emitEvent } = makeDeps();

    const controller = new VoiceController(deps);

    void controller.start();

    await flush();

    emitEvent({ conn: 999, kind: "speech-started" });

    expect(controller.getState().state).toBe("listening");

    controller.stop("test");

    await vi.advanceTimersByTimeAsync(400);

    expect(controller.getState().state).toBe("idle");

    expect(playback.push).not.toHaveBeenCalled();
  });

  it("15. microphone failure cleans up and restarts wake", async () => {
    const { deps } = makeDeps();

    deps.createMic = vi.fn(
      () =>
        ({
          start: vi.fn(async () => {
            throw new Error("NotAllowedError");
          }),

          stop: vi.fn(async () => {}),
        }) as unknown as MicPipeline,
    );

    const controller = new VoiceController(deps);

    void controller.start();

    await flush();

    expect(controller.getState().state).toBe("error");

    expect(controller.getState().message).toContain("Microphone");

    await vi.advanceTimersByTimeAsync(400);

    expect(controller.getState().state).toBe("idle");

    expect(deps.onStartWakeEngine).toHaveBeenCalled();
  });

  it("16. websocket failure cleans up correctly", async () => {
    const { deps, bridge } = makeDeps();

    bridge.start = vi.fn(async () => ({
      ok: false as const,
      error: "Voice connection failed.",
      fatal: false,
    }));

    const controller = new VoiceController(deps);

    void controller.start();

    await vi.advanceTimersByTimeAsync(1000);

    await vi.advanceTimersByTimeAsync(400);

    expect(controller.getState().state).toBe("idle");

    expect(deps.onStartWakeEngine).toHaveBeenCalled();
  });

  it("17-19. duplicate stop is safe; wake stops before mic and restarts after", async () => {
    const { deps, order } = makeDeps();

    const controller = new VoiceController(deps);

    void controller.start();

    await flush();

    expect(order.indexOf("wake-stop")).toBeLessThan(order.indexOf("mic"));

    controller.stop("test");

    controller.stop("test");

    await vi.advanceTimersByTimeAsync(400);

    expect(controller.getState().state).toBe("idle");

    expect(deps.onStartWakeEngine).toHaveBeenCalledTimes(1);
  });

  it("23-24. malformed and unknown-kind events do not crash", async () => {
    const { deps, emitEvent } = makeDeps();

    const controller = new VoiceController(deps);

    void controller.start();

    await flush();

    expect(() => {
      emitEvent({ conn: 1 } as unknown as VoiceRendererEvent);

      emitEvent({
        conn: 1,
        kind: "totally-unknown" as never,
      } as unknown as VoiceRendererEvent);
    }).not.toThrow();

    expect(controller.getState().state).toBe("listening");
  });

  it("25. API key never appears in renderer-facing objects", async () => {
    const { deps } = makeDeps();

    const controller = new VoiceController(deps);

    void controller.start();

    await flush();

    const dumped = JSON.stringify({
      state: controller.getState(),
      transcript: controller.transcript,
      mouth: controller.mouth,
    });

    expect(dumped).not.toContain("EMPIRIOLABS");
    expect(dumped).not.toContain("api_key");
  });

  it("server VAD interrupt: stale audio stays dropped until response.created", async () => {
    const { deps, playback, emitEvent, onAudioCall } = makeDeps();

    const controller = new VoiceController(deps);

    void controller.start();

    await flush();

    onAudioCall()(new ArrayBuffer(64));

    expect(controller.getState().state).toBe("assistant-speaking");

    expect(playback.push).toHaveBeenCalledTimes(1);

    emitEvent({ conn: 1, kind: "speech-started" });

    expect(playback.clear).toHaveBeenCalled();

    expect(controller.getState().state).toBe("user-speaking");

    /*
     * In-flight audio of the interrupted response: dropped.
     */
    onAudioCall()(new ArrayBuffer(64));

    expect(playback.push).toHaveBeenCalledTimes(1);

    /*
     * The cancel does NOT re-accept the dead response's audio.
     */
    emitEvent({ conn: 1, kind: "response-cancelled" });

    expect(controller.getState().state).toBe("user-speaking");

    onAudioCall()(new ArrayBuffer(64));

    expect(playback.push).toHaveBeenCalledTimes(1);

    /*
     * Only a NEW response.created re-opens the audio path.
     */
    emitEvent({ conn: 1, kind: "response-created" });

    onAudioCall()(new ArrayBuffer(64));

    expect(playback.push).toHaveBeenCalledTimes(2);

    expect(controller.getState().state).toBe("assistant-speaking");
  });

  it("assistant audio starts speaking even straight from listening", async () => {
    const { deps, onAudioCall } = makeDeps();

    const controller = new VoiceController(deps);

    void controller.start();

    await flush();

    onAudioCall()(new ArrayBuffer(64));

    expect(controller.getState().state).toBe("assistant-speaking");
  });

  it("output pipeline is warmed up during start", async () => {
    const { deps, playback } = makeDeps();

    const controller = new VoiceController(deps);

    void controller.start();

    await flush();

    expect(playback.warmup).toHaveBeenCalled();
  });

  it("microphone stall fails loudly and recovers", async () => {
    const { deps } = makeDeps();

    deps.micStallTimeoutMs = 100;

    const controller = new VoiceController(deps);

    void controller.start();

    await flush();

    await vi.advanceTimersByTimeAsync(200);

    expect(controller.getState().state).toBe("error");

    expect(controller.getState().message).toContain("stalled");

    await vi.advanceTimersByTimeAsync(500);

    expect(controller.getState().state).toBe("idle");

    expect(deps.onStartWakeEngine).toHaveBeenCalled();
  });

  it("fail-open streams audio when the local gate never fires", async () => {
    const { deps, bridge, emitChunk } = makeDeps();

    const controller = new VoiceController(deps);

    void controller.start();

    await flush();

    for (let i = 0; i < 12; i += 1) {
      emitChunk(0.001);
    }

    expect(bridge.sendAudio).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(4200);

    emitChunk(0.001);

    expect(bridge.sendAudio).toHaveBeenCalled();
  });

  it("silence cycles all capture configurations, then fails loudly", async () => {
    const { deps, mic } = makeDeps();

    const controller = new VoiceController(deps);

    void controller.start();

    await flush();

    for (let i = 0; i < 40; i += 1) {
      emitSilentChunk(deps);
    }

    await flush();

    expect(deps.createMic).toHaveBeenCalledTimes(2);

    expect(deps.createMic.mock.calls[1][1]).toEqual({
      processing: false,
      useDeviceId: true,
    });

    expect(mic.stop).toHaveBeenCalled();

    for (let i = 0; i < 40; i += 1) {
      emitSilentChunk(deps);
    }

    await flush();

    expect(deps.createMic).toHaveBeenCalledTimes(3);

    expect(deps.createMic.mock.calls[2][1]).toEqual({
      processing: true,
      useDeviceId: false,
    });

    for (let i = 0; i < 40; i += 1) {
      emitSilentChunk(deps);
    }

    await flush();

    expect(controller.getState().state).toBe("error");

    expect(controller.getState().message).toContain("not delivering");

    await vi.advanceTimersByTimeAsync(400);

    expect(controller.getState().state).toBe("idle");
  });

  it("tool round: 15s safety idle, no premature close, follow-up plays", async () => {
    const { deps, emitEvent, onAudioCall, emitDrained } = makeDeps();

    const controller = new VoiceController(deps);

    void controller.start();

    await flush();

    emitEvent({ conn: 1, kind: "tool-call", name: "open_app" });

    await vi.advanceTimersByTimeAsync(8000);

    expect(controller.getState().state).toBe("listening");

    emitEvent({ conn: 1, kind: "response-done", usage: null });

    await vi.advanceTimersByTimeAsync(6000);

    expect(controller.getState().state).toBe("listening");

    emitEvent({ conn: 1, kind: "response-created" });

    emitEvent({ conn: 1, kind: "speech-started" });

    emitEvent({ conn: 1, kind: "speech-stopped" });

    onAudioCall()(new ArrayBuffer(48 * 400));

    expect(controller.getState().state).toBe("assistant-speaking");

    emitEvent({ conn: 1, kind: "response-done", usage: null });

    emitDrained();

    expect(controller.getState().state).toBe("listening");
  });

  it("tool-result events never disturb the state", async () => {
    const { deps, emitEvent } = makeDeps();

    const controller = new VoiceController(deps);

    void controller.start();

    await flush();

    emitEvent({ conn: 1, kind: "tool-call", name: "clipboard" });

    emitEvent({ conn: 1, kind: "tool-result", ok: true, summary: "Copied." });

    expect(controller.getState().state).toBe("listening");
  });
});

function emitSilentChunk(deps: ReturnType<typeof makeDeps>["deps"]): void {
  const call = (deps.createMic as ReturnType<typeof vi.fn>).mock
    .calls[0][0] as {
    onChunk: (chunk: { samples: Float32Array; rms: number }) => void;
  };

  call.onChunk({ samples: new Float32Array(320), rms: 0 });
}
