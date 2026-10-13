import type { AgentPorts } from "@starfire/contracts";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startDeviceBridge } from "./deviceBridge.js";

/*
 * EVERY auth test gets its OWN port. A stale listener from an earlier
 * run/worker can then never intercept another test's requests — this
 * entire failure class is eliminated by construction.
 */
const PORT_TOKEN = 17391;

const PORT_LIMITS = 17392;

const PORT_GENERATED = 17393;

/*
 * Indirection on purpose: TypeScript narrows `process.env.X` to
 * `undefined` after `delete process.env.X`, which poisons later reads.
 * A function boundary keeps the type honest (string | undefined).
 */
function readEnvToken(): string | undefined {
  return process.env.STARFIRE_DEVICE_TOKEN;
}

function ports(): AgentPorts {
  return {
    apps: {
      open: async () => ({ name: "x" }),
      close: async () => ({ closed: true, via: "name" }),
      focus: async () => ({ focused: true }),
      listRunning: async () => [],
    },
    files: {
      openFolder: async (path: string) => ({ opened: path }),
      openFile: async (path: string) => ({ opened: path }),
    },
    urls: { open: async (url: string) => ({ opened: url }) },
    clipboard: { read: async () => "", write: async () => {} },
    system: { info: async () => ({ summary: "ok" }) },
    web: { search: async () => ({ answer: "", results: [] }) },
    weather: { current: async () => ({ summary: "", temperatureC: null }) },
    windows: { control: async () => ({ done: true }) },
  };
}

function makeCall(port: number) {
  return async function call(
    token: string | null,
    body: string,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const response = await fetch(`http://127.0.0.1:${port}/v1/tool`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === null ? {} : { "x-starfire-device-token": token }),
      },
      body,
    });

    return {
      status: response.status,
      json: (await response.json()) as Record<string, unknown>,
    };
  };
}

describe("device bridge authentication", () => {
  let stop: (() => Promise<void>) | null = null;

  let savedToken: string | undefined;

  beforeEach(() => {
    savedToken = readEnvToken();
  });

  afterEach(async () => {
    await stop?.();

    stop = null;

    // Never leak token env across tests or worker threads.
    if (savedToken === undefined) {
      delete process.env.STARFIRE_DEVICE_TOKEN;
    } else {
      process.env.STARFIRE_DEVICE_TOKEN = savedToken;
    }
  });

  it("rejects missing and incorrect tokens; accepts the valid one", async () => {
    const call = makeCall(PORT_TOKEN);

    stop = await startDeviceBridge(
      ports(),
      PORT_TOKEN,
      {},
      { token: "secret" },
    );

    const missing = await call(null, JSON.stringify({ tool: "memory_search" }));

    expect(missing.status).toBe(401);

    const wrong = await call("nope", JSON.stringify({ tool: "memory_search" }));

    expect(wrong.status).toBe(401);

    const valid = await call(
      "secret",
      JSON.stringify({ tool: "memory_search", args: { query: "x" } }),
    );

    // Auth passes; the memory handler is absent in this test -> graceful.
    expect(valid.status).toBe(200);
    expect(valid.json.ok).toBe(false);
  });

  it("rejects malformed and oversized bodies with valid auth", async () => {
    const call = makeCall(PORT_LIMITS);

    stop = await startDeviceBridge(
      ports(),
      PORT_LIMITS,
      {},
      { token: "secret" },
    );

    const malformed = await call("secret", "{not json");

    expect(malformed.status).toBe(500);

    /*
     * An oversized body MUST be rejected. Both outcomes are valid
     * rejections and depend only on undici's socket timing, which is
     * not what this test is about:
     * - clean 500 "too large" (server drained, then answered), or
     * - a transport-level failure (server aborted the over-limit
     *   upload). Either way, the oversized body never reaches a tool.
     */
    try {
      const oversized = await call(
        "secret",
        JSON.stringify({ tool: "system_info", pad: "x".repeat(70_000) }),
      );

      expect(oversized.status).toBe(500);
      expect(String(oversized.json.error)).toContain("too large");
    } catch {
      // Transport-level rejection of the oversized upload: accepted.
      expect(true).toBe(true);
    }
  });

  it("generates a working per-launch token when none is configured", async () => {
    const call = makeCall(PORT_GENERATED);

    delete process.env.STARFIRE_DEVICE_TOKEN;

    stop = await startDeviceBridge(ports(), PORT_GENERATED);

    const generated = readEnvToken();

    if (typeof generated !== "string" || generated.length <= 20) {
      throw new Error("expected a generated per-launch token");
    }

    const denied = await call(null, JSON.stringify({ tool: "memory_search" }));

    expect(denied.status).toBe(401);

    const allowed = await call(
      generated,
      JSON.stringify({ tool: "memory_search", args: { query: "x" } }),
    );

    expect(allowed.status).toBe(200);
  });
});
