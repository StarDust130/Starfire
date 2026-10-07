import type { ToolCall, ToolContext, ToolResult } from "@starfire/contracts";
import { createDefaultRegistry } from "@starfire/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AgentRunner,
  type AgentTurnEvent,
  type ToolExecutor,
} from "./agent-runner.js";

function okResult(call: ToolCall): ToolResult {
  return {
    callId: call.callId,

    ok: true,

    summary: `done:${call.name}`,
  };
}

type ExecutorWithCalls = ToolExecutor & {
  calls: ToolCall[];
};

/**
 * Tracking executor:
 * records every call it receives so tests can
 * assert on order and count.
 */
function makeExecutor(): ExecutorWithCalls {
  const calls: ToolCall[] = [];

  return {
    calls,

    execute: vi.fn(async (call: ToolCall) => {
      calls.push(call);

      return okResult(call);
    }),
  };
}

function makeCall(name: string, index = 0): ToolCall {
  return {
    callId: `call-${index}`,

    name,

    args: {},
  };
}

let events: AgentTurnEvent[] = [];

let logs: string[] = [];

function buildRunner(
  overrides: {
    executor?: ToolExecutor;

    maxCallsPerTurn?: number;
  } = {},
): AgentRunner {
  events = [];

  logs = [];

  return new AgentRunner({
    executor: overrides.executor ?? makeExecutor(),

    maxCallsPerTurn: overrides.maxCallsPerTurn,

    log: (message: string) => logs.push(message),

    onEvent: (event) => events.push(event),
  });
}

beforeEach(() => {
  events = [];

  logs = [];
});

describe("AgentRunner", () => {
  it("executes nothing for an empty turn but still reports it", async () => {
    const executor = makeExecutor();

    const runner = buildRunner({
      executor,
    });

    const results = await runner.run([]);

    expect(results).toEqual([]);

    expect(executor.calls).toEqual([]);

    const completed = events.find((event) => event.kind === "turn-completed");

    expect(completed).toEqual({
      kind: "turn-completed",

      total: 0,

      ok: 0,

      failed: 0,
    });
  });

  it("executes a single call and passes the result through", async () => {
    const executor = makeExecutor();

    const runner = buildRunner({
      executor,
    });

    const results = await runner.run([makeCall("open_app")]);

    expect(results).toHaveLength(1);

    expect(results[0]).toMatchObject({
      callId: "call-0",

      ok: true,

      summary: "done:open_app",
    });

    expect(executor.calls).toHaveLength(1);
  });

  it("executes multiple calls sequentially in order", async () => {
    const executor = makeExecutor();

    const runner = buildRunner({
      executor,
    });

    const results = await runner.run([
      makeCall("open_app", 0),

      makeCall("clipboard", 1),

      makeCall("system_info", 2),
    ]);

    expect(results).toHaveLength(3);

    expect(executor.calls.map((call) => call.callId)).toEqual([
      "call-0",
      "call-1",
      "call-2",
    ]);

    expect(results.map((result) => result.callId)).toEqual([
      "call-0",
      "call-1",
      "call-2",
    ]);
  });

  it("caps calls per turn and rejects overflow calls", async () => {
    const executor = makeExecutor();

    const runner = buildRunner({
      executor,

      maxCallsPerTurn: 2,
    });

    const results = await runner.run([
      makeCall("open_app", 0),

      makeCall("open_app", 1),

      makeCall("open_app", 2),

      makeCall("open_app", 3),
    ]);

    /*
     * All valid calls receive a result.
     *
     * First 2 execute.
     * Remaining 2 are rejected by the runner.
     */
    expect(results).toHaveLength(4);

    expect(executor.calls).toHaveLength(2);

    expect(results[0]).toMatchObject({
      callId: "call-0",

      ok: true,
    });

    expect(results[1]).toMatchObject({
      callId: "call-1",

      ok: true,
    });

    expect(results[2]).toMatchObject({
      callId: "call-2",

      ok: false,

      error: "tool-limit-exceeded",
    });

    expect(results[3]).toMatchObject({
      callId: "call-3",

      ok: false,

      error: "tool-limit-exceeded",
    });

    expect(logs.some((message) => message.includes("cap 2"))).toBe(true);
  });

  it("rejects an invalid maxCallsPerTurn", () => {
    expect(
      () =>
        new AgentRunner({
          executor: makeExecutor(),

          maxCallsPerTurn: 0,
        }),
    ).toThrow("maxCallsPerTurn must be a positive integer.");

    expect(
      () =>
        new AgentRunner({
          executor: makeExecutor(),

          maxCallsPerTurn: -1,
        }),
    ).toThrow("maxCallsPerTurn must be a positive integer.");

    expect(
      () =>
        new AgentRunner({
          executor: makeExecutor(),

          maxCallsPerTurn: 1.5,
        }),
    ).toThrow("maxCallsPerTurn must be a positive integer.");
  });

  it("skips malformed calls", async () => {
    const executor = makeExecutor();

    const runner = buildRunner({
      executor,
    });

    const results = await runner.run([
      {
        callId: "",

        name: "open_app",

        args: {},
      },

      {
        callId: "ok",

        name: "",

        args: {},
      },

      makeCall("open_app", 7),
    ]);

    expect(results).toHaveLength(1);

    expect(results[0]?.callId).toBe("call-7");

    expect(executor.calls).toHaveLength(1);

    expect(logs.some((message) => message.includes("malformed"))).toBe(true);
  });

  it("a throwing executor degrades to a per-call failure", async () => {
    const broken: ToolExecutor = {
      execute: vi.fn(async () => {
        throw new Error("executor exploded");
      }),
    };

    const runner = buildRunner({
      executor: broken,
    });

    const results = await runner.run([makeCall("open_app")]);

    expect(results).toHaveLength(1);

    expect(results[0]?.ok).toBe(false);

    expect(results[0]?.error).toBe("internal-error");

    expect(results[0]?.summary).not.toContain("exploded");
  });

  it("emits turn events in order with correct tallies", async () => {
    const mixed: ToolExecutor = {
      execute: vi.fn(
        async (call: ToolCall): Promise<ToolResult> =>
          call.name === "bad"
            ? {
                callId: call.callId,

                ok: false,

                summary: "no",

                error: "tool-error",
              }
            : okResult(call),
      ),
    };

    const runner = buildRunner({
      executor: mixed,
    });

    await runner.run([
      makeCall("good", 0),

      makeCall("bad", 1),
    ]);

    expect(events.map((event) => event.kind)).toEqual([
      "turn-started",
      "call-result",
      "call-result",
      "turn-completed",
    ]);

    const completed = events.find((event) => event.kind === "turn-completed");

    expect(completed).toMatchObject({
      total: 2,

      ok: 1,

      failed: 1,
    });
  });

  it("passes the tool context through to the executor", async () => {
    const executor = makeExecutor();

    const runner = buildRunner({
      executor,
    });

    const ctx: ToolContext = {
      log: vi.fn(),
    };

    await runner.run([makeCall("open_app")], ctx);

    expect(executor.execute).toHaveBeenCalledWith(
      expect.anything(),

      ctx,
    );
  });
});

describe("AgentRunner -> ToolRegistry -> Tool (full chain)", () => {
  function createFakePorts() {
    return {
      apps: {
        open: vi.fn(async (_app: string) => ({
          name: "VS Code",

          pid: 4242,
        })),

        close: vi.fn(async (_app: string) => ({
          closed: true,

          via: "pid" as const,
        })),

        focus: vi.fn(async (_app: string) => ({
          focused: false,

          detail: "Window focusing is not supported on Wayland yet.",
        })),

        listRunning: vi.fn(async () => ["VS Code"]),
      },

      files: {
        openFolder: vi.fn(async (_path: string) => ({
          opened: "Projects",
        })),

        openFile: vi.fn(async (_path: string) => ({
          opened: "README.md",
        })),
      },

      urls: {
        open: vi.fn(async (url: string) => ({
          opened: url,
        })),
      },

      clipboard: {
        read: vi.fn(async () => "hello world"),

        write: vi.fn(async (_text: string) => {}),
      },

      system: {
        info: vi.fn(async (_query) => ({
          summary: "You're using 62% of your 16 GB of RAM.",
        })),
      },

      web: {
        search: vi.fn(async (_query: string) => ({
          answer: "test",

          results: [],
        })),
      },

      weather: {
        current: vi.fn(async (_place?: string) => ({
          summary: "It's 25°C in Bhilai right now.",

          temperatureC: 25,

          data: {},
        })),
      },

      windows: {
        control: vi.fn(async (_action, _app) => ({
          done: true,
        })),
      },
    };
  }

  it('runs "open VS Code" end to end through the real registry', async () => {
    const ports = createFakePorts();

    const registry = createDefaultRegistry(ports);

    const runner = buildRunner({
      executor: registry,
    });

    const results = await runner.run([
      {
        callId: "qwen-call-1",

        name: "open_app",

        args: {
          app: "vs code",
        },
      },
    ]);

    expect(results).toHaveLength(1);

    expect(results[0]).toMatchObject({
      callId: "qwen-call-1",

      ok: true,

      summary: "Opening VS Code.",

      data: {
        app: "VS Code",

        pid: 4242,
      },
    });

    expect(ports.apps.open).toHaveBeenCalledWith("vs code");
  });

  it("an unknown model tool degrades to a graceful spoken failure", async () => {
    const registry = createDefaultRegistry(createFakePorts());

    const runner = buildRunner({
      executor: registry,
    });

    const results = await runner.run([
      {
        callId: "qwen-call-2",

        name: "format_disk",

        args: {},
      },
    ]);

    expect(results[0]?.ok).toBe(false);

    expect(results[0]?.error).toBe("unknown-tool");

    expect(results[0]?.summary).toContain("format_disk");
  });

  it("stops at the configured limit in the full chain", async () => {
    const ports = createFakePorts();

    const registry = createDefaultRegistry(ports);

    const runner = buildRunner({
      executor: registry,

      maxCallsPerTurn: 2,
    });

    const results = await runner.run([
      {
        callId: "qwen-1",

        name: "open_app",

        args: {
          app: "vs code",
        },
      },

      {
        callId: "qwen-2",

        name: "open_app",

        args: {
          app: "discord",
        },
      },

      {
        callId: "qwen-3",

        name: "open_app",

        args: {
          app: "firefox",
        },
      },
    ]);

    expect(results).toHaveLength(3);

    expect(ports.apps.open).toHaveBeenCalledTimes(2);

    expect(results[2]).toMatchObject({
      callId: "qwen-3",

      ok: false,

      error: "tool-limit-exceeded",
    });
  });
});
