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

  it("unexpected close mid-conversation auto-reconnects", async () => {
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

  it("survives the full reconnect budget, then gives up cleanly", async () => {
    const { deps, bridge, emitEvent } = makeDeps();

    const controller = new VoiceController(deps);

    void controller.start();

    await flush();

    for (let drop = 1; drop <= 20; drop += 1) {
      emitEvent({ conn: 1, kind: "closed" });

      await vi.advanceTimersByTimeAsync(800);

      expect(bridge.start).toHaveBeenCalledTimes(drop + 1);

      expect(controller.getState().state).toBe("listening");
    }

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

    onAudioCall()(new ArrayBuffer(64));

    expect(playback.push).toHaveBeenCalledTimes(1);

    emitEvent({ conn: 1, kind: "response-cancelled" });

    expect(controller.getState().state).toBe("user-speaking");

    onAudioCall()(new ArrayBuffer(64));

    expect(playback.push).toHaveBeenCalledTimes(1);

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

  it("session-ended ends the session cleanly without reconnect", async () => {
    const { deps, bridge, emitEvent } = makeDeps();

    const controller = new VoiceController(deps);

    void controller.start();

    await flush();

    emitEvent({ conn: 1, kind: "session-ended" });

    expect(controller.getState().state).toBe("listening");

    /*
     * The goodbye grace is 12000ms, then cleanup takes another 350ms
     * before the state reaches idle — so advance a bit further.
     */
    await vi.advanceTimersByTimeAsync(12400);

    expect(controller.getState().state).toBe("idle");

    expect(deps.onStartWakeEngine).toHaveBeenCalled();

    expect(bridge.start).toHaveBeenCalledTimes(1);
  });
});

function emitSilentChunk(deps: ReturnType<typeof makeDeps>["deps"]): void {
  const call = (deps.createMic as ReturnType<typeof vi.fn>).mock
    .calls[0][0] as {
    onChunk: (chunk: { samples: Float32Array; rms: number }) => void;
  };

  call.onChunk({ samples: new Float32Array(320), rms: 0 });
}

/*
 * P0 foundation regressions: idle-timer races, dispose cleanup, and
 * microphone rebuild failures must never kill or strand a session.
 */
describe("P0 foundation regressions", () => {
  it("P0-1: the tool-round idle timer never closes her follow-up response", async () => {
    const { deps, emitEvent, onAudioCall, emitDrained } = makeDeps();

    const controller = new VoiceController(deps);

    void controller.start();

    await flush();

    emitEvent({ conn: 1, kind: "tool-call", name: "open_app" });

    emitEvent({ conn: 1, kind: "tool-result", ok: true, summary: "done" });

    emitEvent({ conn: 1, kind: "response-created" });

    /*
     * A long streamed response: audio keeps arriving while she speaks,
     * crossing the old 15s tool-round timer boundary several times.
     */
    for (let second = 0; second < 8; second += 1) {
      await vi.advanceTimersByTimeAsync(2000);

      onAudioCall()(new ArrayBuffer(48 * 400));

      expect(controller.getState().state).toBe("assistant-speaking");
    }

    emitEvent({ conn: 1, kind: "response-done", usage: null });

    emitDrained();

    expect(controller.getState().state).toBe("listening");

    await vi.advanceTimersByTimeAsync(VOICE_IDLE_AFTER_RESPONSE_MS + 200);

    expect(controller.getState().state).toBe("closing");
  });

  it("P0-1: awaiting playback drain postpones the idle watchdog", async () => {
    const { deps, emitEvent, onAudioCall } = makeDeps();

    const controller = new VoiceController(deps);

    void controller.start();

    await flush();

    onAudioCall()(new ArrayBuffer(48 * 400));

    emitEvent({ conn: 1, kind: "response-done", usage: null });

    expect(controller.getState().state).toBe("assistant-speaking");

    /*
     * Cross the old 7s idle boundary while her audio is still playing
     * out (awaiting drain) — she must not be disconnected. The 6s
     * drain watchdog finishes the response first.
     */
    await vi.advanceTimersByTimeAsync(3000);

    expect(controller.getState().state).toBe("assistant-speaking");

    await vi.advanceTimersByTimeAsync(4000);

    expect(controller.getState().state).toBe("listening");

    /*
     * The fresh post-response idle timer then closes the session once
     * she is actually idle.
     */
    await vi.advanceTimersByTimeAsync(6100);

    expect(controller.getState().state).toBe("closing");

    await vi.advanceTimersByTimeAsync(500);

    expect(controller.getState().state).toBe("idle");
  });

  it("P0-1: audible playback postpones idle; quiet session closes afterwards", async () => {
    const { deps, onAudioCall } = makeDeps();

    const controller = new VoiceController(deps);

    void controller.start();

    await flush();

    onAudioCall()(new ArrayBuffer(48 * 400));

    const playbackCall = (deps.createPlayback as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { onLevel: (rms: number) => void };

    /*
     * No response.done ever arrives, but the worklet keeps reporting
     * output levels — she is audibly speaking for 30s (a very long
     * reply). No idle timer may close the session under her.
     */
    for (let second = 0; second < 15; second += 1) {
      await vi.advanceTimersByTimeAsync(2000);

      playbackCall.onLevel(0.2);
    }

    expect(controller.getState().state).toBe("assistant-speaking");

    /*
     * Playback goes quiet (level 0 reports stop) — the next watchdog
     * fire finds a truly idle session and closes it.
     */
    playbackCall.onLevel(0);

    await vi.advanceTimersByTimeAsync(6200);

    expect(controller.getState().state).toBe("closing");

    await vi.advanceTimersByTimeAsync(1000);

    expect(controller.getState().state).toBe("idle");
  });

  it("P0-1: user speech postpones idle; a silent session closes on stall", async () => {
    const { deps, emitChunk } = makeDeps();

    const controller = new VoiceController(deps);

    void controller.start();

    await flush();

    /*
     * The user speaks for 10s — loud chunks with single quiet frames
     * in between (like real speech) keep the local gate and the
     * upload flowing, so the 12s activation watchdog must postpone,
     * not kill.
     */
    for (let second = 0; second < 10; second += 1) {
      await vi.advanceTimersByTimeAsync(1000);

      emitChunk(0.4);

      emitChunk(0.0001);
    }

    expect(controller.getState().state).toBe("user-speaking");

    /*
     * The user stops talking (and no server turn-end ever arrives) —
     * once uploads go quiet past the stall window, the watchdog closes
     * the session instead of hanging forever.
     */
    await vi.advanceTimersByTimeAsync(20000);

    expect(["closing", "idle"]).toContain(controller.getState().state);
  });

  it("P0-3: dispose stops mic, playback, bridge, and all timers mid-session", async () => {
    const { deps, mic, playback, bridge } = makeDeps();

    const controller = new VoiceController(deps);

    void controller.start();

    await flush();

    expect(controller.getState().state).toBe("listening");

    controller.dispose();

    expect(mic.stop).toHaveBeenCalled();

    expect(playback.stop).toHaveBeenCalled();

    expect(bridge.stop).toHaveBeenCalled();

    /*
     * Timers that used to leak through dispose must not fire into the
     * void afterwards: no wake restart, no further state changes.
     */
    await vi.advanceTimersByTimeAsync(20000);

    expect(deps.onStartWakeEngine).not.toHaveBeenCalled();

    expect(controller.getState().state).toBe("listening");

    expect(() => controller.dispose()).not.toThrow();

    expect(() => controller.stop("late")).not.toThrow();
  });

  it("P0-3: dispose while starting still stops the microphone pipeline", async () => {
    const { deps, bridge } = makeDeps();

    let resolveMicStart: ((rate: number) => void) | undefined;

    deps.createMic = vi.fn(
      () =>
        ({
          start: vi.fn(
            () =>
              new Promise<number>((resolve) => {
                resolveMicStart = resolve;
              }),
          ),

          stop: vi.fn(async () => {}),
        }) as unknown as MicPipeline,
    );

    const controller = new VoiceController(deps);

    const starting = controller.start();

    await flush();

    controller.dispose();

    resolveMicStart?.(16000);

    await flush();

    await starting;

    expect(bridge.stop).toHaveBeenCalled();

    const mic = deps.createMic.mock.results[0].value as MicPipeline;

    expect(mic.stop).toHaveBeenCalled();
  });

  it("P0-4: rebuild failures retry remaining variants, then fail loudly", async () => {
    const { deps } = makeDeps();

    const micHandlers: Array<{
      onChunk: (chunk: { samples: Float32Array; rms: number }) => void;
    }> = [];

    const micStops: Array<ReturnType<typeof vi.fn>> = [];

    deps.createMic = vi.fn(
      (handlers: {
        onChunk: (chunk: { samples: Float32Array; rms: number }) => void;
      }) => {
        micHandlers.push(handlers);

        const callIndex = micHandlers.length - 1;

        const stop = vi.fn(async () => {});

        micStops.push(stop);

        return {
          start: vi.fn(async () => {
            if (callIndex === 0) {
              return 16000;
            }

            throw new Error("AudioContext creation failed");
          }),

          stop,
        } as MicPipeline;
      },
    );

    const controller = new VoiceController(deps);

    void controller.start();

    await flush();

    expect(controller.getState().state).toBe("listening");

    for (let i = 0; i < 40; i += 1) {
      micHandlers[0].onChunk({ samples: new Float32Array(320), rms: 0 });
    }

    await flush();

    await vi.advanceTimersByTimeAsync(50);

    /*
     * Attempt 2 and 3 both fail to open — the session must fail loudly
     * instead of surviving deaf.
     */
    expect(deps.createMic).toHaveBeenCalledTimes(3);

    expect(controller.getState().state).toBe("error");

    expect(controller.getState().message).toContain("not delivering");

    expect(micStops[0]).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(400);

    expect(controller.getState().state).toBe("idle");

    expect(deps.onStartWakeEngine).toHaveBeenCalled();
  });

  it("P0-4: silence while she speaks never triggers a mic rebuild", async () => {
    const { deps, onAudioCall } = makeDeps();

    const controller = new VoiceController(deps);

    void controller.start();

    await flush();

    onAudioCall()(new ArrayBuffer(48 * 400));

    expect(controller.getState().state).toBe("assistant-speaking");

    /*
     * Echo-cancelled capture is digitally silent during playback —
     * this must not be treated as a broken microphone.
     */
    for (let i = 0; i < 100; i += 1) {
      emitSilentChunk(deps);
    }

    await flush();

    expect(deps.createMic).toHaveBeenCalledTimes(1);

    expect(controller.getState().state).toBe("assistant-speaking");
  });

  it("P0-1b: a stale goodbye timer cannot close a newer session", async () => {
    const { deps, bridge, emitEvent } = makeDeps();

    const controller = new VoiceController(deps);

    void controller.start();

    await flush();

    emitEvent({ conn: 1, kind: "session-ended" });

    expect(controller.getState().state).toBe("listening");

    controller.stop("test");

    await vi.advanceTimersByTimeAsync(400);

    expect(controller.getState().state).toBe("idle");

    void controller.start();

    await flush();

    expect(controller.getState().state).toBe("listening");

    /*
     * Keep the new session busy in a tool round: its own stall
     * watchdog (15s) is now armed, so crossing the original 12s
     * goodbye boundary must not close anything.
     */
    emitEvent({ conn: 1, kind: "tool-call", name: "open_app" });

    await vi.advanceTimersByTimeAsync(12000);

    expect(bridge.start).toHaveBeenCalledTimes(2);

    expect(controller.getState().state).toBe("listening");
  });
});
