import type { AgentPorts } from "@starfire/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RealtimeVoiceBridge } from "./realtimeVoice.js";

type IpcHandler = (...args: unknown[]) => unknown;
type SocketHandler = (...args: unknown[]) => void;

const ipcHandlers = new Map<string, IpcHandler>();
const ipcListeners = new Map<string, IpcHandler>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: unknown) => {
      ipcHandlers.set(channel, handler as IpcHandler);
    }),

    on: vi.fn((channel: string, handler: unknown) => {
      ipcListeners.set(channel, handler as IpcHandler);
    }),

    removeHandler: vi.fn((channel: string) => {
      ipcHandlers.delete(channel);
    }),

    removeAllListeners: vi.fn((channel: string) => {
      ipcListeners.delete(channel);
    }),
  },
}));

const { FakeWebSocket } = vi.hoisted(() => {
  class FakeWebSocket {
    static OPEN = 1;
    static instances: FakeWebSocket[] = [];

    readyState = 0;
    closed = false;
    sent: string[] = [];

    private handlers = new Map<string, SocketHandler[]>();

    constructor() {
      FakeWebSocket.instances.push(this);
    }

    on(event: string, handler: SocketHandler): void {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
    }

    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(...args);
      }
    }

    open(): void {
      this.readyState = FakeWebSocket.OPEN;
    }

    send(data: string): void {
      this.sent.push(data);

      // The production bridge waits for the provider to acknowledge
      // session.update before reporting that the connection is ready.
      try {
        const message = JSON.parse(data) as { type?: string };

        if (message.type === "session.update") {
          this.emit(
            "message",
            JSON.stringify({
              type: "session.updated",
              session: {
                model: "m",
                voice: "Tina",
                input_audio_format: "pcm16",
                output_audio_format: "pcm16",
                turn_detection: { type: "server_vad" },
              },
            }),
          );
        }
      } catch {
        // Ignore non-JSON frames in the fake WebSocket.
      }
    }

    close(): void {
      if (this.closed) return;

      this.closed = true;
      this.readyState = 3;
      this.emit("close", 1000);
    }

    terminate(): void {
      this.closed = true;
      this.readyState = 3;
    }
  }

  return { FakeWebSocket };
});

vi.mock("ws", () => ({
  default: FakeWebSocket,
}));

function makePorts(): AgentPorts {
  return {
    apps: {
      open: vi.fn(async () => ({ name: "Discord", pid: 1 })),
      close: vi.fn(async () => ({
        closed: true,
        via: "pid" as const,
      })),
      focus: vi.fn(async () => ({ focused: true })),
      listRunning: vi.fn(async () => []),
    },
    files: {
      openFolder: vi.fn(async () => ({ opened: "folder" })),
      openFile: vi.fn(async () => ({ opened: "file" })),
    },
    urls: {
      open: vi.fn(async () => ({ opened: "example.com" })),
    },
    clipboard: {
      read: vi.fn(async () => "text"),
      write: vi.fn(async () => {}),
    },
    system: {
      info: vi.fn(async () => ({ summary: "ok" })),
    },
    web: {
      search: vi.fn(async () => ({ answer: "a", results: [] })),
    },
    weather: {
      current: vi.fn(async () => ({
        summary: "s",
        temperatureC: 1,
      })),
    },
    windows: {
      control: vi.fn(async () => ({ done: true })),
    },
  };
}

function makeBridge(): RealtimeVoiceBridge {
  return new RealtimeVoiceBridge(() => null, makePorts());
}

function getStartHandler(): () => Promise<{
  ok: boolean;
  conn?: number;
  error?: string;
  fatal?: boolean;
}> {
  const handler = ipcHandlers.get("starfire-voice:start");

  if (!handler) {
    throw new Error("start handler not registered");
  }

  return handler as () => Promise<{
    ok: boolean;
    conn?: number;
    error?: string;
    fatal?: boolean;
  }>;
}

function getStopHandler(): () => Promise<void> {
  const handler = ipcHandlers.get("starfire-voice:stop");

  if (!handler) {
    throw new Error("stop handler not registered");
  }

  return handler as () => Promise<void>;
}

function sessionCreatedMessage(): string {
  return JSON.stringify({
    type: "session.created",
    session: {
      model: "m",
      voice: "Tina",
    },
  });
}

function emitIpc(channel: string, ...args: unknown[]): void {
  const handler = ipcListeners.get(channel);

  if (!handler) {
    throw new Error(`IPC listener not registered: ${channel}`);
  }

  handler({}, ...args);
}

function hasAudioAppend(socket: InstanceType<typeof FakeWebSocket>): boolean {
  return socket.sent.some((payload) => {
    try {
      return (
        (JSON.parse(payload) as { type?: string }).type ===
        "input_audio_buffer.append"
      );
    } catch {
      return false;
    }
  });
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  ipcHandlers.clear();
  ipcListeners.clear();

  process.env.EMPIRIOLABS_API_KEY = "test-key";
  delete process.env.EMPIRIOLABS_REALTIME_URL;

  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("RealtimeVoiceBridge warm connection and stale-socket safety", () => {
  it("warms the provider connection and reuses it on activation", async () => {
    const bridge = makeBridge();
    bridge.register();

    const warming = bridge.warmUp();
    const socket = FakeWebSocket.instances[0];

    expect(socket).toBeDefined();

    socket.open();
    socket.emit("message", sessionCreatedMessage());

    await expect(warming).resolves.toBeUndefined();

    expect(
      socket.sent.some((payload) => payload.includes("session.update")),
    ).toBe(true);

    await expect(getStartHandler()()).resolves.toEqual({
      ok: true,
      conn: 1,
    });

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(socket.closed).toBe(false);

    await bridge.dispose();
  });

  it("does not transmit audio while inactive, but does while active", async () => {
    const bridge = makeBridge();
    bridge.register();

    const warming = bridge.warmUp();
    const socket = FakeWebSocket.instances[0];

    socket.open();
    socket.emit("message", sessionCreatedMessage());

    await warming;

    emitIpc("starfire-voice:audio", "YWJj");

    expect(hasAudioAppend(socket)).toBe(false);

    await getStartHandler()();

    emitIpc("starfire-voice:audio", "YWJj");

    expect(hasAudioAppend(socket)).toBe(true);

    await getStopHandler()();

    const appendCountAfterStop = socket.sent.filter((payload) => {
      try {
        return (
          (JSON.parse(payload) as { type?: string }).type ===
          "input_audio_buffer.append"
        );
      } catch {
        return false;
      }
    }).length;

    emitIpc("starfire-voice:audio", "ZGVm");

    const appendCountAfterInactiveSend = socket.sent.filter((payload) => {
      try {
        return (
          (JSON.parse(payload) as { type?: string }).type ===
          "input_audio_buffer.append"
        );
      } catch {
        return false;
      }
    }).length;

    expect(appendCountAfterInactiveSend).toBe(appendCountAfterStop);
    expect(socket.closed).toBe(false);

    await bridge.dispose();
  });

  it("ignores late close/error events from an older socket", async () => {
    const bridge = makeBridge();
    bridge.register();

    const first = getStartHandler()();
    const socketA = FakeWebSocket.instances[0];

    expect(socketA).toBeDefined();

    socketA.emit("error", new Error("boom"));

    await expect(first).resolves.toMatchObject({ ok: false });

    socketA.emit("close", 1006);

    const second = getStartHandler()();
    const socketB = FakeWebSocket.instances[1];

    expect(socketB).toBeDefined();
    expect(socketB).not.toBe(socketA);

    socketA.emit("close", 1006);
    socketA.emit("error", new Error("late error"));

    socketB.open();
    socketB.emit("message", sessionCreatedMessage());

    await expect(second).resolves.toEqual({ ok: true, conn: 2 });
    expect(socketB.closed).toBe(false);

    await bridge.dispose();
  });

  it("ignores tool messages from an older socket", async () => {
    const bridge = makeBridge();
    bridge.register();

    const first = getStartHandler()();
    const socketA = FakeWebSocket.instances[0];

    socketA.emit("error", new Error("boom"));
    await first;

    socketA.emit("close", 1006);

    const second = getStartHandler()();
    const socketB = FakeWebSocket.instances[1];

    socketB.open();
    socketB.emit("message", sessionCreatedMessage());

    await second;

    const sentBefore = socketB.sent.length;

    const staleToolCall = JSON.stringify({
      type: "response.function_call_arguments.done",
      call_id: "stale-1",
      name: "open_app",
      arguments: JSON.stringify({ app: "Discord" }),
    });

    socketA.emit("message", staleToolCall);

    expect(socketB.sent).toHaveLength(sentBefore);

    socketB.emit("message", staleToolCall);
    socketB.emit("message", JSON.stringify({ type: "response.done" }));

    await vi.advanceTimersByTimeAsync(0);

    expect(socketB.sent.length).toBeGreaterThan(sentBefore);
    expect(
      socketB.sent.some((line) => line.includes("function_call_output")),
    ).toBe(true);

    await bridge.dispose();
  });

  it("the connect timeout closes its own socket, not a newer one", async () => {
    const bridge = makeBridge();
    bridge.register();

    const first = getStartHandler()();
    const socketA = FakeWebSocket.instances[0];

    expect(socketA).toBeDefined();

    await vi.advanceTimersByTimeAsync(10_000);

    await expect(first).resolves.toMatchObject({ ok: false });
    expect(socketA.closed).toBe(true);

    const second = getStartHandler()();
    const socketB = FakeWebSocket.instances[1];

    socketB.open();
    socketB.emit("message", sessionCreatedMessage());

    await expect(second).resolves.toEqual({ ok: true, conn: 2 });
    expect(socketB.closed).toBe(false);

    await bridge.dispose();
  });

  it("socket errors during connect allow a fresh retry", async () => {
    const bridge = makeBridge();
    bridge.register();

    const first = getStartHandler()();
    const socketA = FakeWebSocket.instances[0];

    socketA.emit("error", new Error("ECONNREFUSED"));

    await expect(first).resolves.toMatchObject({ ok: false });
    expect(socketA.closed).toBe(true);

    const second = getStartHandler()();
    const socketB = FakeWebSocket.instances[1];

    socketB.open();
    socketB.emit("message", sessionCreatedMessage());

    await expect(second).resolves.toEqual({ ok: true, conn: 2 });
    expect(socketB.closed).toBe(false);

    await bridge.dispose();
  });

  it("socket errors mid-session allow a new connection", async () => {
    const bridge = makeBridge();
    bridge.register();

    const first = getStartHandler()();
    const socketA = FakeWebSocket.instances[0];

    socketA.open();
    socketA.emit("message", sessionCreatedMessage());

    await expect(first).resolves.toEqual({ ok: true, conn: 1 });

    socketA.emit("error", new Error("connection reset"));

    expect(socketA.closed).toBe(true);

    const second = getStartHandler()();
    const socketB = FakeWebSocket.instances[1];

    socketB.open();
    socketB.emit("message", sessionCreatedMessage());

    await expect(second).resolves.toEqual({ ok: true, conn: 2 });
    expect(socketB.closed).toBe(false);

    await bridge.dispose();
  });

  it("a stale goodbye timer does not close the reused warm connection", async () => {
    const bridge = makeBridge();
    bridge.register();

    const start = getStartHandler()();
    const socket = FakeWebSocket.instances[0];

    socket.open();
    socket.emit("message", sessionCreatedMessage());

    await start;

    socket.emit(
      "message",
      JSON.stringify({
        type: "response.function_call_arguments.done",
        call_id: "call-1",
        name: "end_session",
        arguments: "{}",
      }),
    );

    socket.emit("message", JSON.stringify({ type: "response.done" }));
    await vi.advanceTimersByTimeAsync(50);

    socket.emit("message", JSON.stringify({ type: "response.done" }));
    await vi.advanceTimersByTimeAsync(200);

    await getStopHandler()();

    expect(socket.closed).toBe(false);

    await expect(getStartHandler()()).resolves.toEqual({
      ok: true,
      conn: 1,
    });

    await vi.advanceTimersByTimeAsync(3000);

    expect(socket.closed).toBe(false);

    await bridge.dispose();
  });

  it("end_session deactivates voice but retains the warm socket", async () => {
    const bridge = makeBridge();
    bridge.register();

    const start = getStartHandler()();
    const socket = FakeWebSocket.instances[0];

    socket.open();
    socket.emit("message", sessionCreatedMessage());

    await start;

    socket.emit(
      "message",
      JSON.stringify({
        type: "response.function_call_arguments.done",
        call_id: "call-1",
        name: "end_session",
        arguments: "{}",
      }),
    );

    socket.emit("message", JSON.stringify({ type: "response.done" }));
    await vi.advanceTimersByTimeAsync(50);

    socket.emit("message", JSON.stringify({ type: "response.done" }));
    await vi.advanceTimersByTimeAsync(1600);

    expect(socket.closed).toBe(false);

    await bridge.dispose();
  });

  it("tool calls report completion duration and success", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const bridge = makeBridge();
    bridge.register();

    const start = getStartHandler()();
    const socket = FakeWebSocket.instances[0];

    socket.open();
    socket.emit("message", sessionCreatedMessage());

    await start;

    socket.emit(
      "message",
      JSON.stringify({
        type: "response.function_call_arguments.done",
        call_id: "call-1",
        name: "open_app",
        arguments: JSON.stringify({ app: "Discord" }),
      }),
    );

    socket.emit("message", JSON.stringify({ type: "response.done" }));
    await vi.advanceTimersByTimeAsync(50);

    const toolLog = logSpy.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes("event=tool-complete"));

    expect(toolLog).toContain("tool=open_app");
    expect(toolLog).toContain("ok=true");
    expect(toolLog).toContain("durationMs=");
    expect(toolLog).not.toContain("test-key");

    await bridge.dispose();
  });

  it("dispose resolves pending starts and is safe to call twice", async () => {
    const bridge = makeBridge();
    bridge.register();

    const pending = getStartHandler()();
    const socket = FakeWebSocket.instances[0];

    await bridge.dispose();

    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.error).toContain("shutting down");
    expect(socket.closed).toBe(true);

    await expect(bridge.dispose()).resolves.toBeUndefined();
  });
});
