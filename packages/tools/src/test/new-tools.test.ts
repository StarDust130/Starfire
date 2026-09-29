import type { AgentPorts } from "@starfire/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDefaultRegistry } from "../defaults.js";

function createFakePorts(): AgentPorts {
  return {
    apps: {
      open: vi.fn(async (_app: string) => ({ name: "X" })),

      close: vi.fn(async (_app: string) => ({
        closed: true,
        via: "pid" as const,
      })),

      focus: vi.fn(async (_app: string) => ({ focused: false, detail: "no" })),
    },

    files: {
      openFolder: vi.fn(async (_p: string) => ({ opened: "F" })),

      openFile: vi.fn(async (_p: string) => ({ opened: "F" })),
    },

    clipboard: {
      read: vi.fn(async () => "c"),

      write: vi.fn(async (_t: string) => {}),
    },

    system: {
      info: vi.fn(async (_q: "memory") => ({ summary: "s" })),
    },

    web: {
      search: vi.fn(async (_q: string) => ({
        answer: "I found 2 results for that.",

        results: [
          { title: "A", url: "https://a", snippet: "snippet a" },

          { title: "B", url: "https://b", snippet: "snippet b" },
        ],
      })),
    },

    weather: {
      current: vi.fn(async (_place?: string) => ({
        summary: "It's 21°C in Tokyo right now.",

        temperatureC: 21,
      })),
    },

    windows: {
      control: vi.fn(async (_action: string, _app?: string) => ({
        done: false,

        detail: "Window control isn't supported on Wayland yet — coming soon!",
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

describe("web_search", () => {
  it("is registered and returns results", async () => {
    expect(registry.has("web_search")).toBe(true);

    const result = await registry.execute({
      callId: "w1",

      name: "web_search",

      args: { query: "vitest 5 release" },
    });

    expect(result.ok).toBe(true);

    expect(result.summary).toContain("2 results");

    const results = result.data?.results;

    expect(Array.isArray(results)).toBe(true);

    expect((results as unknown[]).length).toBe(2);

    expect(ports.web.search).toHaveBeenCalledWith("vitest 5 release");
  });

  it("empty search becomes a friendly failure", async () => {
    ports.web.search = vi.fn(async () => ({ answer: "", results: [] }));

    const result = await registry.execute({
      callId: "w2",

      name: "web_search",

      args: { query: "nothing" },
    });

    expect(result.ok).toBe(false);

    expect(result.error).toBe("tool-error");

    expect(result.summary).toContain("nothing");
  });

  it("missing query is invalid-args", async () => {
    const result = await registry.execute({
      callId: "w3",

      name: "web_search",

      args: {},
    });

    expect(result.ok).toBe(false);

    expect(result.error).toBe("invalid-args");
  });
});

describe("get_weather", () => {
  it("returns the port summary with no place", async () => {
    const result = await registry.execute({
      callId: "t1",

      name: "get_weather",

      args: {},
    });

    expect(result.ok).toBe(true);

    expect(result.summary).toContain("21°C");

    expect(ports.weather.current).toHaveBeenCalledWith(undefined);
  });

  it("passes the place through", async () => {
    await registry.execute({
      callId: "t2",

      name: "get_weather",

      args: { place: "Tokyo" },
    });

    expect(ports.weather.current).toHaveBeenCalledWith("Tokyo");
  });

  it("port failure becomes a spoken failure", async () => {
    ports.weather.current = vi.fn(async () => {
      throw new Error("offline");
    });

    const result = await registry.execute({
      callId: "t3",

      name: "get_weather",

      args: {},
    });

    expect(result.ok).toBe(false);

    expect(result.error).toBe("internal-error");

    expect(result.summary).not.toContain("offline");
  });
});

describe("window_control", () => {
  it("honest Wayland response is a graceful spoken failure", async () => {
    const result = await registry.execute({
      callId: "wc1",

      name: "window_control",

      args: { action: "focus", app: "brave" },
    });

    expect(result.ok).toBe(false);

    expect(result.error).toBe("tool-error");

    expect(result.summary).toContain("Wayland");

    expect(ports.windows.control).toHaveBeenCalledWith("focus", "brave");
  });

  it("each of the 5 actions validates and reaches the port", async () => {
    for (const action of [
      "focus",
      "lower",
      "minimize",
      "maximize",
      "restore",
    ] as const) {
      const result = await registry.execute({
        callId: `wc-${action}`,

        name: "window_control",

        args: { action },
      });

      expect(result.ok).toBe(false);

      expect(result.summary).toContain("Wayland");
    }

    expect(ports.windows.control).toHaveBeenCalledTimes(5);
  });

  it("unknown action is rejected by enum validation", async () => {
    const result = await registry.execute({
      callId: "wc2",

      name: "window_control",

      args: { action: "destroy" },
    });

    expect(result.ok).toBe(false);

    expect(result.error).toBe("invalid-args");
  });

  it("adapter 'not done' without detail becomes a spoken failure", async () => {
    ports.windows.control = vi.fn(async () => ({ done: false }));

    const result = await registry.execute({
      callId: "wc3",

      name: "window_control",

      args: { action: "minimize" },
    });

    expect(result.ok).toBe(false);

    expect(result.error).toBe("tool-error");
  });

  it("success returns the action phrase", async () => {
    ports.windows.control = vi.fn(async () => ({ done: true }));

    const result = await registry.execute({
      callId: "wc4",

      name: "window_control",

      args: { action: "minimize" },
    });

    expect(result.ok).toBe(true);

    expect(result.summary).toBe("Minimized.");
  });

  it("maps synonyms to canonical actions before calling the port", async () => {
    await registry.execute({
      callId: "wc5",

      name: "window_control",

      args: { action: "unminimize", app: "brave" },
    });

    expect(ports.windows.control).toHaveBeenCalledWith("restore", "brave");

    await registry.execute({
      callId: "wc6",

      name: "window_control",

      args: { action: "bring-to-front", app: "chrome" },
    });

    expect(ports.windows.control).toHaveBeenCalledWith("focus", "chrome");
  });
});

describe("current_date_time", () => {
  it("returns date, time, day, and timezone", async () => {
    const result = await registry.execute({
      callId: "d1",

      name: "current_date_time",

      args: {},
    });

    expect(result.ok).toBe(true);

    expect(result.summary).toMatch(/It's \d{2}:\d{2}:\d{2} on \w+,/);

    expect(result.data?.day).toBeTruthy();

    expect(result.data?.timezone).toBeTruthy();
  });

  it("produces a 10-character ISO-style date", async () => {
    const result = await registry.execute({
      callId: "d2",

      name: "current_date_time",

      args: {},
    });

    expect(result.ok).toBe(true);

    const date = typeof result.data?.date === "string" ? result.data.date : "";

    expect(date.length).toBe(10);
  });

  it("requires no arguments at all (null args are coerced)", async () => {
    const result = await registry.execute({
      callId: "d3",

      name: "current_date_time",

      args: null,
    });

    expect(result.ok).toBe(true);
  });
});

describe("full V0 set", () => {
  it("now registers 11 tools", () => {
    expect(registry.names()).toEqual([
      "open_app",

      "close_app",

      "focus_app",

      "open_folder",

      "open_file",

      "clipboard",

      "system_info",

      "web_search",

      "get_weather",

      "window_control",

      "current_date_time",
    ]);
  });
});
