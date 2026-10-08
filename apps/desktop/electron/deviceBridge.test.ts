import type { AgentPorts } from "@starfire/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startDeviceBridge } from "./deviceBridge";

/*
 * Device bridge regressions: the HTTP boundary Eve tools call must
 * dispatch through the shared Starfire capability layer, fail safely
 * on bad input, and shut down cleanly.
 */

function makePorts(): AgentPorts {
  return {
    apps: {
      open: vi.fn(async (app: string) => ({ name: app, pid: 42 })),

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
      read: vi.fn(async () => "clipboard text"),

      write: vi.fn(async () => {}),
    },

    system: {
      info: vi.fn(async () => ({ summary: "ok" })),
    },

    web: {
      search: vi.fn(async () => ({ answer: "a", results: [] })),
    },

    weather: {
      current: vi.fn(async () => ({ summary: "sunny", temperatureC: 20 })),
    },

    windows: {
      control: vi.fn(async () => ({ done: true })),
    },
  };
}

let stop: (() => Promise<void>) | null = null;

let baseUrl = "";

beforeEach(async () => {
  const ports = makePorts();

  stop = await startDeviceBridge(ports, 17321);

  baseUrl = "http://127.0.0.1:17321";
});

afterEach(async () => {
  await stop?.();

  stop = null;
});

async function postTool(body: unknown): Promise<{
  status: number;

  json: { ok: boolean; result?: unknown; error?: string };
}> {
  const response = await fetch(`${baseUrl}/v1/tool`, {
    method: "POST",

    headers: { "content-type": "application/json" },

    body: JSON.stringify(body),
  });

  return {
    status: response.status,

    json: (await response.json()) as {
      ok: boolean;

      result?: unknown;

      error?: string;
    },
  };
}

describe("device bridge", () => {
  it("rejects non-POST requests", async () => {
    const response = await fetch(`${baseUrl}/v1/tool`, { method: "GET" });

    expect(response.status).toBe(405);
  });

  it("404s unknown paths", async () => {
    const response = await fetch(`${baseUrl}/other`, { method: "POST" });

    expect(response.status).toBe(404);
  });

  it("dispatches open_app through the shared capability layer", async () => {
    const { status, json } = await postTool({
      tool: "open_app",

      args: { app: "Discord" },
    });

    expect(status).toBe(200);

    expect(json.ok).toBe(true);

    expect(json.result).toEqual({ name: "Discord", pid: 42 });
  });

  it("maps the model-facing clipboard capability", async () => {
    const { json } = await postTool({
      tool: "clipboard",

      args: { action: "read" },
    });

    expect(json.ok).toBe(true);

    expect(json.result).toEqual({ text: "clipboard text" });
  });

  it("canonicalizes window action synonyms", async () => {
    const ports = makePorts();

    const stopLocal = await startDeviceBridge(ports, 17322);

    try {
      await fetch("http://127.0.0.1:17322/v1/tool", {
        method: "POST",

        headers: { "content-type": "application/json" },

        body: JSON.stringify({
          tool: "window_control",

          args: { action: "unminimize", app: "Firefox" },
        }),
      });

      expect(ports.windows.control).toHaveBeenCalledWith("restore", "Firefox");
    } finally {
      await stopLocal();
    }
  });

  it("returns graceful errors for missing args", async () => {
    const { status, json } = await postTool({ tool: "open_app", args: {} });

    expect(status).toBe(500);

    expect(json.ok).toBe(false);

    expect(json.error).toContain("app");
  });

  it("returns graceful errors for unknown tools", async () => {
    const { status, json } = await postTool({ tool: "shell", args: {} });

    expect(status).toBe(500);

    expect(json.ok).toBe(false);

    expect(json.error).toContain("Unknown device tool");
  });

  it("returns graceful errors for malformed JSON", async () => {
    const response = await fetch(`${baseUrl}/v1/tool`, {
      method: "POST",

      headers: { "content-type": "application/json" },

      body: "not json",
    });

    expect(response.status).toBe(500);

    const json = (await response.json()) as { ok: boolean };

    expect(json.ok).toBe(false);
  });

  it("rejects non-object bodies", async () => {
    const response = await fetch(`${baseUrl}/v1/tool`, {
      method: "POST",

      headers: { "content-type": "application/json" },

      body: "[1,2,3]",
    });

    expect(response.status).toBe(500);
  });
});
