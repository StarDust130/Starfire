import type { ToolCall } from "@starfire/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toolPolicies } from "../policy.js";
import { type ToolDefinition, ToolRegistry } from "../registry.js";

import { ToolError } from "../tool-error.js";

function makeCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    callId: "call-1",

    name: "system_info",

    args: {
      query: "memory",
    },

    ...overrides,
  };
}

const queryTool: ToolDefinition = {
  manifest: {
    name: "system_info",

    description: "test tool",

    danger: "safe",

    parameters: {
      type: "object",

      properties: {
        query: {
          type: "string",

          description: "what to query",

          enum: ["memory", "cpu"],
        },

        note: {
          type: "string",

          description: "optional note",
        },
      },

      required: ["query"],
    },
  },

  handle: async (args) => ({
    summary: `q=${String(args.query)}`,

    data: {
      query: args.query,
    },
  }),
};

let registry: ToolRegistry;

beforeEach(() => {
  vi.useFakeTimers();

  registry = new ToolRegistry();

  registry.register(queryTool);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ToolRegistry", () => {
  it("registers tools and exposes manifests", () => {
    expect(registry.has("system_info")).toBe(true);

    expect(registry.names()).toEqual(["system_info"]);

    expect(registry.manifests()[0]?.name).toBe("system_info");
  });

  it("rejects duplicate registration", () => {
    expect(() => registry.register(queryTool)).toThrow("already registered");
  });

  it("requires a policy when registering a tool", () => {
    const badTool: ToolDefinition = {
      manifest: {
        name: "open_app",
        description: "test",
        danger: "safe",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },

      handle: async () => ({
        summary: "ok",
      }),
    };

    expect(() => registry.register(badTool)).not.toThrow();
  });

  it("functionTools() matches the session config shape", () => {
    const tools = registry.functionTools();

    expect(tools).toHaveLength(1);

    expect(tools[0]).toEqual({
      type: "function",

      name: "system_info",

      description: "test tool",

      parameters: queryTool.manifest.parameters,
    });
  });

  it("unknown tool returns a friendly failure", async () => {
    const result = await registry.execute(
      makeCall({
        name: "terminal",
      }),
    );

    expect(result.ok).toBe(false);

    expect(result.error).toBe("unknown-tool");

    expect(result.summary).toContain("terminal");
  });

  it("missing required argument is caught", async () => {
    const result = await registry.execute(
      makeCall({
        args: {},
      }),
    );

    expect(result.ok).toBe(false);

    expect(result.error).toBe("invalid-args");

    expect(result.summary).toContain("query");
  });

  it("wrong argument type is caught", async () => {
    const result = await registry.execute(
      makeCall({
        args: {
          query: 5,
        },
      }),
    );

    expect(result.ok).toBe(false);

    expect(result.error).toBe("invalid-args");

    expect(result.summary).toContain("must be a string");
  });

  it("empty string argument is caught", async () => {
    const result = await registry.execute(
      makeCall({
        args: {
          query: "  ",
        },
      }),
    );

    expect(result.ok).toBe(false);

    expect(result.error).toBe("invalid-args");

    expect(result.summary).toContain("must not be empty");
  });

  it("bad enum value is caught", async () => {
    const result = await registry.execute(
      makeCall({
        args: {
          query: "ram",
        },
      }),
    );

    expect(result.ok).toBe(false);

    expect(result.error).toBe("invalid-args");

    expect(result.summary).toContain("memory, cpu");
  });

  it("extra unknown keys are ignored", async () => {
    const result = await registry.execute(
      makeCall({
        args: {
          query: "memory",
          junk: "x",
        },
      }),
    );

    expect(result.ok).toBe(true);

    expect(result.summary).toBe("q=memory");
  });

  it("optional arguments are optional", async () => {
    expect((await registry.execute(makeCall())).ok).toBe(true);
  });

  it("success passes summary and data", async () => {
    const result = await registry.execute(
      makeCall({
        callId: "call-99",

        args: {
          query: "cpu",
        },
      }),
    );

    expect(result.callId).toBe("call-99");

    expect(result.ok).toBe(true);

    expect(result.summary).toBe("q=cpu");

    expect(result.data).toEqual({
      query: "cpu",
    });
  });

  it("ToolError becomes a spoken failure", async () => {
    registry.register({
      manifest: {
        name: "clipboard",

        description: "boom",

        danger: "safe",

        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },

      handle: async () => {
        throw new ToolError("Your clipboard is empty.");
      },
    });

    const result = await registry.execute(
      makeCall({
        name: "clipboard",
        args: {},
      }),
    );

    expect(result.ok).toBe(false);

    expect(result.error).toBe("tool-error");

    expect(result.summary).toBe("Your clipboard is empty.");
  });

  it("unexpected errors become generic failures", async () => {
    const logs: string[] = [];

    registry.register({
      manifest: {
        name: "clipboard",

        description: "boom",

        danger: "safe",

        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },

      handle: async () => {
        throw new Error("EPIPE");
      },
    });

    const result = await registry.execute(
      makeCall({
        name: "clipboard",
        args: {},
      }),
      {
        log: (message) => logs.push(message),
      },
    );

    expect(result.ok).toBe(false);

    expect(result.error).toBe("internal-error");

    expect(result.summary).not.toContain("EPIPE");

    expect(logs[0]).toContain("EPIPE");
  });

  it("disabled tools cannot execute", async () => {
    const previous = toolPolicies.system_info.enabled;

    toolPolicies.system_info.enabled = false;

    try {
      const result = await registry.execute(makeCall());

      expect(result.ok).toBe(false);

      expect(result.error).toBe("policy-denied");
    } finally {
      toolPolicies.system_info.enabled = previous;
    }
  });

  it("confirmation blocks a dangerous tool", async () => {
    const dangerousTool: ToolDefinition = {
      manifest: {
        name: "open_app",

        description: "dangerous test",

        danger: "confirm",

        parameters: {
          type: "object",

          properties: {
            app: {
              type: "string",

              description: "app",
            },
          },

          required: ["app"],
        },
      },

      handle: async () => ({
        summary: "executed",
      }),
    };

    const dangerousRegistry = new ToolRegistry();

    dangerousRegistry.register(dangerousTool);

    const result = await dangerousRegistry.execute({
      callId: "danger-1",

      name: "open_app",

      args: {
        app: "Discord",
      },
    });

    expect(result.ok).toBe(false);

    expect(result.error).toBe("confirmation-required");
  });

  it("confirmation allows a dangerous tool", async () => {
    const dangerousTool: ToolDefinition = {
      manifest: {
        name: "open_app",

        description: "dangerous test",

        danger: "confirm",

        parameters: {
          type: "object",

          properties: {
            app: {
              type: "string",

              description: "app",
            },
          },

          required: ["app"],
        },
      },

      handle: async (args) => ({
        summary: `opened ${String(args.app)}`,
      }),
    };

    const dangerousRegistry = new ToolRegistry();

    dangerousRegistry.register(dangerousTool);

    const result = await dangerousRegistry.execute(
      {
        callId: "danger-2",

        name: "open_app",

        args: {
          app: "Discord",
        },
      },
      {
        confirm: async (request) => {
          expect(request.tool).toBe("open_app");

          expect(request.args).toEqual({
            app: "Discord",
          });

          return true;
        },
      },
    );

    expect(result.ok).toBe(true);

    expect(result.summary).toBe("opened Discord");
  });

  it("confirmation denial prevents execution", async () => {
    const dangerousTool: ToolDefinition = {
      manifest: {
        name: "open_app",

        description: "dangerous test",

        danger: "confirm",

        parameters: {
          type: "object",

          properties: {
            app: {
              type: "string",

              description: "app",
            },
          },

          required: ["app"],
        },
      },

      handle: async () => ({
        summary: "SHOULD NOT RUN",
      }),
    };

    const dangerousRegistry = new ToolRegistry();

    dangerousRegistry.register(dangerousTool);

    const result = await dangerousRegistry.execute(
      {
        callId: "danger-3",

        name: "open_app",

        args: {
          app: "Discord",
        },
      },
      {
        confirm: async () => false,
      },
    );

    expect(result.ok).toBe(false);

    expect(result.error).toBe("confirmation-denied");
  });

  it("hung tools are cut off by timeout", async () => {
    registry.register({
      manifest: {
        name: "open_app",

        description: "hangs",

        danger: "safe",

        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },

      handle: () => new Promise(() => {}),
    });

    const pending = registry.execute(
      makeCall({
        name: "open_app",
        args: {},
      }),
    );

    await vi.advanceTimersByTimeAsync(11000);

    const result = await pending;

    expect(result.ok).toBe(false);

    expect(result.summary).toContain("took too long");
  });
});
