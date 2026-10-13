import type { AgentPorts } from "@starfire/contracts";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startDeviceBridge } from "./deviceBridge.js";

const PORT = 17330;

const TEST_TOKEN = "test-token";

function createPorts(): {
  ports: AgentPorts;
  open: ReturnType<typeof vi.fn>;
  control: ReturnType<typeof vi.fn>;
} {
  const open = vi.fn(async (name: string) => ({ name, pid: 4242 }));

  const control = vi.fn(async () => ({ done: true }));

  const ports = {
    apps: {
      open,
      close: vi.fn(async () => ({ closed: true, via: "name" })),
      focus: vi.fn(async () => ({ focused: true })),
      listRunning: vi.fn(async () => []),
    },
    files: {
      openFolder: vi.fn(async (path: string) => ({ opened: path })),
      openFile: vi.fn(async (path: string) => ({ opened: path })),
    },
    urls: {
      open: vi.fn(async (url: string) => ({ opened: url })),
    },
    clipboard: {
      read: vi.fn(async () => "clipboard text"),
      write: vi.fn(async () => undefined),
    },
    system: {
      info: vi.fn(async () => ({ summary: "all good" })),
    },
    web: {
      search: vi.fn(async () => ({ answer: "", results: [] })),
    },
    weather: {
      current: vi.fn(async () => ({ summary: "", temperatureC: null })),
    },
    windows: {
      control,
    },
  };

  return { ports: ports as unknown as AgentPorts, open, control };
}

async function postTool(
  body: string,
  token: string | null = TEST_TOKEN,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${PORT}/v1/tool`, {
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
}

describe("device bridge", () => {
  let stop: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await stop?.();

    stop = null;
  });

  it("rejects non-POST requests", async () => {
    stop = await startDeviceBridge(
      createPorts().ports,
      PORT,
      {},
      { token: TEST_TOKEN },
    );

    const response = await fetch(`http://127.0.0.1:${PORT}/v1/tool`, {
      method: "GET",
    });

    expect(response.status).toBe(405);
  });

  it("404s unknown paths", async () => {
    stop = await startDeviceBridge(
      createPorts().ports,
      PORT,
      {},
      { token: TEST_TOKEN },
    );

    const response = await fetch(`http://127.0.0.1:${PORT}/other`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-starfire-device-token": TEST_TOKEN,
      },
      body: "{}",
    });

    expect(response.status).toBe(404);
  });

  it("dispatches open_app through the shared capability layer", async () => {
    const { ports, open } = createPorts();

    stop = await startDeviceBridge(ports, PORT, {}, { token: TEST_TOKEN });

    const { status, json } = await postTool(
      JSON.stringify({ tool: "open_app", args: { app: "Firefox" } }),
    );

    expect(status).toBe(200);

    expect(json.ok).toBe(true);

    expect(open).toHaveBeenCalledWith("Firefox");
  });

  it("maps the model-facing clipboard capability", async () => {
    stop = await startDeviceBridge(
      createPorts().ports,
      PORT,
      {},
      { token: TEST_TOKEN },
    );

    const { status, json } = await postTool(
      JSON.stringify({ tool: "clipboard", args: { action: "read" } }),
    );

    expect(status).toBe(200);

    expect(json.ok).toBe(true);

    expect(json.result).toEqual({ text: "clipboard text" });
  });

  it("canonicalizes window action synonyms", async () => {
    const { ports, control } = createPorts();

    stop = await startDeviceBridge(ports, PORT, {}, { token: TEST_TOKEN });

    try {
      await postTool(
        JSON.stringify({
          tool: "window_control",
          args: { action: "unminimize", app: "Firefox" },
        }),
      );

      expect(control).toHaveBeenCalledWith("restore", "Firefox");
    } finally {
      await stopLocal();
    }
  });

  async function stopLocal(): Promise<void> {
    await stop?.();

    stop = null;
  }

  it("returns graceful errors for missing args", async () => {
    stop = await startDeviceBridge(
      createPorts().ports,
      PORT,
      {},
      { token: TEST_TOKEN },
    );

    const { status, json } = await postTool(
      JSON.stringify({ tool: "open_app", args: {} }),
    );

    expect(status).toBe(500);

    expect(json.ok).toBe(false);
  });

  it("returns graceful errors for unknown tools", async () => {
    stop = await startDeviceBridge(
      createPorts().ports,
      PORT,
      {},
      { token: TEST_TOKEN },
    );

    const { status, json } = await postTool(
      JSON.stringify({ tool: "shell", args: {} }),
    );

    expect(status).toBe(500);

    expect(json.ok).toBe(false);
  });

  it("returns graceful errors for malformed JSON", async () => {
    stop = await startDeviceBridge(
      createPorts().ports,
      PORT,
      {},
      { token: TEST_TOKEN },
    );

    const response = await fetch(`http://127.0.0.1:${PORT}/v1/tool`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-starfire-device-token": TEST_TOKEN,
      },
      body: "{not json",
    });

    expect(response.status).toBe(500);

    const json = (await response.json()) as { ok: boolean };

    expect(json.ok).toBe(false);
  });

  it("rejects non-object bodies", async () => {
    stop = await startDeviceBridge(
      createPorts().ports,
      PORT,
      {},
      { token: TEST_TOKEN },
    );

    const response = await fetch(`http://127.0.0.1:${PORT}/v1/tool`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-starfire-device-token": TEST_TOKEN,
      },
      body: JSON.stringify([1, 2, 3]),
    });

    expect(response.status).toBe(500);
  });
});
