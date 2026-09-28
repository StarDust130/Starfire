import type { AgentPorts, SystemInfoQuery } from "@starfire/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDefaultRegistry } from "../defaults.js";

function createFakePorts(): AgentPorts {
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
    },

    files: {
      openFolder: vi.fn(async (_path: string) => ({ opened: "Projects" })),

      openFile: vi.fn(async (_path: string) => ({ opened: "README.md" })),
    },

    clipboard: {
      read: vi.fn(async () => "hello world"),

      write: vi.fn(async (_text: string) => {}),
    },

    system: {
      info: vi.fn(async (_query: SystemInfoQuery) => ({
        summary: "You're using 62% of your 16 GB of RAM.",

        data: { percent: 62 },
      })),
    },
  };
}

let ports: AgentPorts;

let registry: ReturnType<typeof createDefaultRegistry>;

beforeEach(() => {
  ports = createFakePorts();

  registry = createDefaultRegistry(ports);
});

describe("V0 toolset through the registry", () => {
  it("registers exactly the 7 V0 tools with valid manifests", () => {
    expect(registry.names()).toEqual([
      "open_app",

      "close_app",

      "focus_app",

      "open_folder",

      "open_file",

      "clipboard",

      "system_info",
    ]);

    for (const tool of registry.functionTools()) {
      expect(tool.type).toBe("function");

      expect(tool.description.length).toBeGreaterThan(10);

      expect(Array.isArray(tool.parameters.required)).toBe(true);
    }
  });

  it("open_app: success passes the raw name to the port", async () => {
    const result = await registry.execute({
      callId: "c1",

      name: "open_app",

      args: { app: "vs code" },
    });

    expect(result.ok).toBe(true);

    expect(result.summary).toBe("Opening VS Code.");

    expect(result.data).toEqual({ app: "VS Code", pid: 4242 });

    expect(ports.apps.open).toHaveBeenCalledWith("vs code");
  });

  it("open_app: port failure becomes a spoken failure", async () => {
    ports.apps.open = vi.fn(async () => {
      throw new Error("spawn ENOENT");
    });

    const result = await registry.execute({
      callId: "c2",

      name: "open_app",

      args: { app: "vscode" },
    });

    expect(result.ok).toBe(false);

    expect(result.error).toBe("internal-error");

    expect(result.summary).not.toContain("ENOENT");
  });

  it("open_app: missing argument is rejected before the port is touched", async () => {
    const result = await registry.execute({
      callId: "c3",

      name: "open_app",

      args: {},
    });

    expect(result.ok).toBe(false);

    expect(result.error).toBe("invalid-args");

    expect(ports.apps.open).not.toHaveBeenCalled();
  });

  it("close_app: success", async () => {
    const result = await registry.execute({
      callId: "c4",

      name: "close_app",

      args: { app: "discord" },
    });

    expect(result.ok).toBe(true);

    expect(result.summary).toBe("Closing discord.");

    expect(result.data).toEqual({ app: "discord", via: "pid" });
  });

  it("close_app: app not running becomes a friendly failure", async () => {
    ports.apps.close = vi.fn(async (_app: string) => ({
      closed: false,

      via: "not-found" as const,

      detail: "Discord doesn't appear to be running right now.",
    }));

    const result = await registry.execute({
      callId: "c5",

      name: "close_app",

      args: { app: "Discord" },
    });

    expect(result.ok).toBe(false);

    expect(result.error).toBe("tool-error");

    expect(result.summary).toContain("Discord doesn't appear to be running");
  });

  it("focus_app: honestly reports the Wayland limitation", async () => {
    const result = await registry.execute({
      callId: "c6",

      name: "focus_app",

      args: { app: "chrome" },
    });

    expect(result.ok).toBe(true);

    expect(result.summary).toContain("not supported on Wayland");

    expect(result.data).toEqual({ app: "chrome", focused: false });
  });

  it("open_folder: success", async () => {
    const result = await registry.execute({
      callId: "c7",

      name: "open_folder",

      args: { path: "~/Projects" },
    });

    expect(result.ok).toBe(true);

    expect(result.summary).toBe("Opening Projects.");

    expect(ports.files.openFolder).toHaveBeenCalledWith("~/Projects");
  });

  it("open_file: success", async () => {
    const result = await registry.execute({
      callId: "c8",

      name: "open_file",

      args: { path: "README.md" },
    });

    expect(result.ok).toBe(true);

    expect(result.summary).toBe("Opening README.md.");
  });

  it("clipboard read: returns the content", async () => {
    const result = await registry.execute({
      callId: "c9",

      name: "clipboard",

      args: { action: "read" },
    });

    expect(result.ok).toBe(true);

    expect(result.summary).toContain("hello world");
  });

  it("clipboard read: empty clipboard is a normal answer", async () => {
    ports.clipboard.read = vi.fn(async () => "");

    const result = await registry.execute({
      callId: "c10",

      name: "clipboard",

      args: { action: "read" },
    });

    expect(result.ok).toBe(true);

    expect(result.summary).toBe("Your clipboard is empty.");
  });

  it("clipboard write: success", async () => {
    const result = await registry.execute({
      callId: "c11",

      name: "clipboard",

      args: { action: "write", text: "copy me" },
    });

    expect(result.ok).toBe(true);

    expect(result.summary).toBe("Copied that to your clipboard.");

    expect(ports.clipboard.write).toHaveBeenCalledWith("copy me");
  });

  it("clipboard write: missing text asks the user", async () => {
    const result = await registry.execute({
      callId: "c12",

      name: "clipboard",

      args: { action: "write" },
    });

    expect(result.ok).toBe(false);

    expect(result.error).toBe("tool-error");

    expect(result.summary).toContain("What should I copy");

    expect(ports.clipboard.write).not.toHaveBeenCalled();
  });

  it("clipboard: bad action enum is rejected by validation", async () => {
    const result = await registry.execute({
      callId: "c13",

      name: "clipboard",

      args: { action: "clear" },
    });

    expect(result.ok).toBe(false);

    expect(result.error).toBe("invalid-args");
  });

  it("system_info: returns the port's summary", async () => {
    const result = await registry.execute({
      callId: "c14",

      name: "system_info",

      args: { query: "memory" },
    });

    expect(result.ok).toBe(true);

    expect(result.summary).toContain("62%");

    expect(result.data).toEqual({ percent: 62 });

    expect(ports.system.info).toHaveBeenCalledWith("memory");
  });
});
