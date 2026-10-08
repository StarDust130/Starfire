import type { AgentPorts } from "@starfire/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RealtimeVoiceBridge } from "./realtimeVoice.js";

/*
 * Main-process voice bridge regressions:
 *   P0-2 — stale WebSocket events must never affect a newer connection
 *   goodbye-close timer ownership across connections
 *   dispose() resolves pending starts and closes the socket
 */

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: unknown) => {
      ipcHandlers.set(channel, handler as (...args: unknown[]) => unknown);
    }),

    on: vi.fn(),

    removeHandler: vi.fn((channel: string) => {
      ipcHandlers.delete(channel);
    }),

    removeAllListeners: vi.fn(),
  },
}));

type SocketHandler = (...args: unknown[]) => void;

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
    }

    close(): void {
      if (this.closed) {
        return;
      }

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

      close: vi.fn(async () => ({ closed: true, via: "pid" as const })),

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
      current: vi.fn(async () => ({ summary: "s", temperatureC: 1 })),
    },

    windows: {
      control: vi.fn(async () => ({ done: true })),
    },
  };
}

function makeBridge(): InstanceType<typeof RealtimeVoiceBridge> {
  return new RealtimeVoiceBridge(() => null, makePorts());
}

function startHandler(): () => Promise<{
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

function sessionCreatedMessage(): string {
  return JSON.stringify({
    type: "session.created",

    session: { model: "m", voice: "Tina" },
  });
}

beforeEach(() => {
  FakeWebSocket.instances = [];

  ipcHandlers.clear();

  process.env.EMPIRIOLABS_API_KEY = "test-key";

  vi.useFakeTimers();
});

describe("RealtimeVoiceBridge stale-socket safety", () => {
  it("P0-2: late close/error from socket #1 never affects socket #2", async () => {
    const bridge = makeBridge();

    bridge.register();

    const first = startHandler()();

    const socketA = FakeWebSocket.instances[0];

    socketA.emit("error", new Error("boom"));

    const firstResult = await first;

    expect(firstResult.ok).toBe(false);

    socketA.emit("close", 1006);

    const second = startHandler()();

    const socketB = FakeWebSocket.instances[1];

    expect(socketB).not.toBe(socketA);

    /*
     * Socket #1 keeps dying AFTER socket #2 was created: duplicate
     * late close/error events must not fail socket #2's pending start
     * nor emit a closed event for the new connection.
     */
    socketA.emit("close", 1006);

    socketA.emit("error", new Error("late error"));

    socketB.open();

    socketB.emit("message", sessionCreatedMessage());

    const secondResult = await second;

    expect(secondResult).toEqual({ ok: true, conn: 2 });

    expect(socketB.closed).toBe(false);
  });

  it("P0-2: late messages from a stale socket are ignored", async () => {
    const bridge = makeBridge();

    bridge.register();

    const first = startHandler()();

    const socketA = FakeWebSocket.instances[0];

    socketA.emit("error", new Error("boom"));

    await first;

    socketA.emit("close", 1006);

    const second = startHandler()();

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

    expect(socketB.sent.length).toBe(sentBefore);

    socketB.emit("message", staleToolCall);

    socketB.emit("message", JSON.stringify({ type: "response.done" }));

    await vi.advanceTimersByTimeAsync(0);

    expect(socketB.sent.length).toBeGreaterThan(sentBefore);

    expect(
      socketB.sent.some((line) => line.includes("function_call_output")),
    ).toBe(true);

    socketB.emit("close", 1000);
  });

  it("P0-2: the connect timeout closes its own socket, not a newer one", async () => {
    const bridge = makeBridge();

    bridge.register();

    const first = startHandler()();

    const socketA = FakeWebSocket.instances[0];

    vi.advanceTimersByTime(10000);

    const firstResult = await first;

    expect(firstResult.ok).toBe(false);

    expect(socketA.closed).toBe(true);

    const second = startHandler()();

    const socketB = FakeWebSocket.instances[1];

    socketA.emit("close", 1000);

    socketB.open();

    socketB.emit("message", sessionCreatedMessage());

    const secondResult = await second;

    expect(secondResult).toEqual({ ok: true, conn: 2 });

    expect(socketB.closed).toBe(false);
  });

  it("the goodbye-close timer never closes a newer connection", async () => {
    const bridge = makeBridge();

    bridge.register();

    const stopHandler = () => {
      const handler = ipcHandlers.get("starfire-voice:stop");

      if (!handler) {
        throw new Error("stop handler not registered");
      }

      return handler as () => Promise<void>;
    };

    const start = startHandler()();

    const socketA = FakeWebSocket.instances[0];

    socketA.open();

    socketA.emit("message", sessionCreatedMessage());

    await start;

    const endSessionCall = JSON.stringify({
      type: "response.function_call_arguments.done",

      call_id: "call-1",

      name: "end_session",

      arguments: "{}",
    });

    socketA.emit("message", endSessionCall);

    socketA.emit("message", JSON.stringify({ type: "response.done" }));

    await vi.advanceTimersByTimeAsync(50);

    socketA.emit("message", JSON.stringify({ type: "response.done" }));

    await vi.advanceTimersByTimeAsync(50);

    /*
     * The goodbye close is armed for 1500ms. The user stops first.
     */
    await vi.advanceTimersByTimeAsync(200);

    await stopHandler()();

    expect(socketA.closed).toBe(true);

    const next = startHandler()();

    const socketB = FakeWebSocket.instances[1];

    socketB.open();

    socketB.emit("message", sessionCreatedMessage());

    await next;

    /*
     * Cross the original goodbye deadline: the stale timer must not
     * close socket B.
     */
    await vi.advanceTimersByTimeAsync(3000);

    expect(socketB.closed).toBe(false);
  });

  it("end_session still closes its own session when nothing interferes", async () => {
    const bridge = makeBridge();

    bridge.register();

    const start = startHandler()();

    const socketA = FakeWebSocket.instances[0];

    socketA.open();

    socketA.emit("message", sessionCreatedMessage());

    await start;

    socketA.emit(
      "message",
      JSON.stringify({
        type: "response.function_call_arguments.done",

        call_id: "call-1",

        name: "end_session",

        arguments: "{}",
      }),
    );

    socketA.emit("message", JSON.stringify({ type: "response.done" }));

    await vi.advanceTimersByTimeAsync(50);

    socketA.emit("message", JSON.stringify({ type: "response.done" }));

    await vi.advanceTimersByTimeAsync(1600);

    expect(socketA.closed).toBe(true);
  });

  it("tool calls report completion with duration and success", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const bridge = makeBridge();

    bridge.register();

    const start = startHandler()();

    const socketA = FakeWebSocket.instances[0];

    socketA.open();

    socketA.emit("message", sessionCreatedMessage());

    await start;

    socketA.emit(
      "message",
      JSON.stringify({
        type: "response.function_call_arguments.done",

        call_id: "call-1",

        name: "open_app",

        arguments: JSON.stringify({ app: "Discord" }),
      }),
    );

    socketA.emit("message", JSON.stringify({ type: "response.done" }));

    await vi.advanceTimersByTimeAsync(50);

    const toolLog = logSpy.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes("event=tool-complete"));

    expect(toolLog).toContain("tool=open_app");

    expect(toolLog).toContain("ok=true");

    expect(toolLog).toContain("durationMs=");

    expect(toolLog).not.toContain("test-key");

    logSpy.mockRestore();

    socketA.emit("close", 1000);
  });

  it("dispose resolves a pending start, closes the socket, and is repeatable", async () => {
    const bridge = makeBridge();

    bridge.register();

    const pending = startHandler()();

    const socketA = FakeWebSocket.instances[0];

    await bridge.dispose();

    const result = await pending;

    expect(result.ok).toBe(false);

    expect(result.error).toContain("shutting down");

    expect(socketA.closed).toBe(true);

    await expect(bridge.dispose()).resolves.toBeUndefined();
  });
});
