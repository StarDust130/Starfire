import {
  type AgentPorts,
  type CloseOutcome,
  type FocusOutcome,
  type OpenedApp,
  type SystemInfoQuery,
  type SystemInfoResult,
  ToolError,
  type WeatherResult,
  type WebSearchResult,
  type WindowAction,
  type WindowControlResult,
} from "../starfire.js";
import type { InjectionT } from "../types.js";

export type AppState = {
  state: "closed" | "running";
  pid?: number;
  window: string;
  focused: boolean;
};

export type MockState = {
  clock: string;
  apps: Record<string, AppState>;
  focusedApp: string | null;
  clipboard: string | null;
  openUrls: string[];
  openFiles: string[];
  openFolders: string[];
  weatherCalls: string[];
  searches: string[];
  sessionEnded: boolean;
  invocations: Record<string, number>;
};

const WEATHER: Record<string, { temperatureC: number; summary: string }> = {
  tokyo: { temperatureC: 18, summary: "18°C with light rain in Tokyo" },
  delhi: { temperatureC: 34, summary: "34°C and sunny in Delhi" },
  london: { temperatureC: 11, summary: "11°C, overcast in London" },
  paris: { temperatureC: 15, summary: "15°C, partly cloudy in Paris" },
};
const DEFAULT_WEATHER = { temperatureC: 24, summary: "24°C, clear skies" };

const SYS_INFO: Record<string, SystemInfoResult> = {
  memory: {
    summary: "Memory usage is at 62% (8.0 of 12.8 GB).",
    data: { usedPct: 62 },
  },
  cpu: { summary: "CPU usage is at 31%.", data: { usedPct: 31 } },
  uptime: { summary: "Uptime is 3 hours 12 minutes.", data: { hours: 3.2 } },
  disk: { summary: "Disk usage is at 71%.", data: { usedPct: 71 } },
  battery: {
    summary: "Battery is at 84% — about 4 hours remaining.",
    data: { pct: 84 },
  },
  host: {
    summary: "Host is starfire-dev running Linux with KWin.",
    data: { os: "linux" },
  },
};

const TIMEOUT_SLEEP_MS = 5000; // eval registry timeout is 2000ms → guaranteed timeout
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type MockSetup = {
  initialState?: Record<string, unknown>;
  clipboardSeed?: string;
  injectedContent?: string;
  injections?: InjectionT[];
};

export class MockOS implements AgentPorts {
  state: MockState;
  events: { port: string; args: unknown; error?: string }[] = [];
  violations: string[] = [];
  injectedContent: string | null;
  private injections: InjectionT[];
  private portCounts: Record<string, number> = {};

  constructor(setup: MockSetup = {}) {
    this.state = {
      clock: "2025-01-15T10:30:00Z",
      apps: {},
      focusedApp: null,
      clipboard: null,
      openUrls: [],
      openFiles: [],
      openFolders: [],
      weatherCalls: [],
      searches: [],
      sessionEnded: false,
      invocations: {},
    };
    if (setup.initialState) {
      for (const [name, st] of Object.entries(setup.initialState)) {
        this.state.apps[name.toLowerCase()] = st as AppState;
      }
    }
    if (setup.clipboardSeed) this.state.clipboard = setup.clipboardSeed;
    this.injectedContent = setup.injectedContent ?? null;
    this.injections = setup.injections ?? [];
  }

  private key(app: string | undefined): string {
    return (app ?? "").trim().toLowerCase();
  }

  snapshot(): MockState {
    return structuredClone(this.state);
  }

  finishSession(): void {
    this.state.sessionEnded = true;
    this.state.invocations.end_session =
      (this.state.invocations.end_session ?? 0) + 1;
  }

  /** Generic guard for non-web ports: tool_error / internal / timeout injections. */
  private async guard(
    port: string,
    fn: () => Promise<void> | void,
  ): Promise<void> {
    this.portCounts[port] = (this.portCounts[port] ?? 0) + 1;
    const n = this.portCounts[port];
    const hit = this.injections.find((i) => i.port === port && i.nth === n);
    if (hit) {
      this.events.push({ port, args: { injected: hit.kind } });
      if (hit.kind === "tool_error")
        throw new ToolError(
          hit.message ?? "Injected failure: the operation failed.",
        );
      if (hit.kind === "internal") throw new Error("ECONNRESET (injected)");
      if (hit.kind === "timeout") {
        await sleep(TIMEOUT_SLEEP_MS);
        throw new ToolError(`The ${port} action took too long.`);
      }
      // empty/malformed/partial only have web.search semantics; degrade to tool error elsewhere
      throw new ToolError(`Injected ${hit.kind} result from ${port}.`);
    }
    await fn();
  }

  readonly apps = {
    open: async (app: string): Promise<OpenedApp> => {
      let out!: OpenedApp;
      await this.guard("apps.open", () => {
        const k = this.key(app);
        const cur = this.state.apps[k];
        if (!cur || cur.state === "closed") {
          if (this.state.focusedApp && this.state.apps[this.state.focusedApp]) {
            this.state.apps[this.state.focusedApp].focused = false;
          }
          this.state.apps[k] = {
            state: "running",
            pid: 1000 + Object.keys(this.state.apps).length + 1,
            window: "normal",
            focused: true,
          };
          this.state.focusedApp = k;
        }
        out = { name: app, pid: this.state.apps[k]?.pid };
      });
      return out;
    },

    close: async (app: string): Promise<CloseOutcome> => {
      let out!: CloseOutcome;
      await this.guard("apps.close", () => {
        const k = this.key(app);
        const cur = this.state.apps[k];
        if (cur?.state !== "running") {
          out = {
            closed: false,
            via: "not-found",
            detail: `${app} is not running`,
          };
          return;
        }
        delete cur.pid;
        cur.state = "closed";
        cur.focused = false;
        if (this.state.focusedApp === k) this.state.focusedApp = null;
        out = { closed: true, via: "name" };
      });
      return out;
    },

    focus: async (app: string): Promise<FocusOutcome> => {
      let out!: FocusOutcome;
      await this.guard("apps.focus", () => {
        const k = this.key(app);
        const cur = this.state.apps[k];
        if (cur?.state !== "running") {
          throw new ToolError(`Couldn't focus ${app}: it is not running.`);
        }
        if (this.state.focusedApp === k) {
          out = { focused: true, detail: "already focused" };
          return;
        }
        if (this.state.focusedApp && this.state.apps[this.state.focusedApp]) {
          this.state.apps[this.state.focusedApp].focused = false;
        }
        cur.focused = true;
        this.state.focusedApp = k;
        out = { focused: true };
      });
      return out;
    },

    listRunning: async (): Promise<string[]> =>
      Object.entries(this.state.apps)
        .filter(([, s]) => s.state === "running")
        .map(([n]) => n),
  };

  readonly files = {
    openFolder: async (path: string): Promise<{ opened: string }> => {
      let out!: { opened: string };
      await this.guard("files.openFolder", () => {
        if (!path.trim()) throw new ToolError("That folder path is empty.");
        this.state.openFolders.push(path);
        out = { opened: path };
      });
      return out;
    },
    openFile: async (path: string): Promise<{ opened: string }> => {
      let out!: { opened: string };
      await this.guard("files.openFile", () => {
        if (!path.trim()) throw new ToolError("That file path is empty.");
        this.state.openFiles.push(path);
        out = { opened: path };
      });
      return out;
    },
  };

  readonly urls = {
    open: async (url: string): Promise<{ opened: string }> => {
      let out!: { opened: string };
      await this.guard("urls.open", () => {
        if (!/^https?:\/\//i.test(url) && !/^www\./i.test(url)) {
          throw new ToolError(`That doesn't look like a valid URL: ${url}`);
        }
        this.state.openUrls.push(url);
        out = { opened: url };
      });
      return out;
    },
  };

  readonly clipboard = {
    read: async (): Promise<string> => {
      let out = "";
      await this.guard("clipboard.read", () => {
        out = this.state.clipboard ?? "";
      });
      return out;
    },
    write: async (text: string): Promise<void> => {
      await this.guard("clipboard.write", () => {
        this.state.clipboard = text;
      });
    },
  };

  readonly system = {
    info: async (query: SystemInfoQuery): Promise<SystemInfoResult> => {
      let out: SystemInfoResult = { summary: "No information available." };
      await this.guard("system.info", () => {
        out = SYS_INFO[query] ?? { summary: `Unknown query: ${String(query)}` };
      });
      return out;
    },
  };

  readonly web = {
    // web.search has dedicated handling so empty/malformed/partial injections
    // produce realistic BAD DATA (not exceptions) — the honest failure mode.
    search: async (query: string): Promise<WebSearchResult> => {
      this.portCounts["web.search"] = (this.portCounts["web.search"] ?? 0) + 1;
      const n = this.portCounts["web.search"];
      const hit = this.injections.find(
        (i) => i.port === "web.search" && i.nth === n,
      );
      this.state.searches.push(query);
      if (hit) {
        this.events.push({ port: "web.search", args: { injected: hit.kind } });
        if (hit.kind === "tool_error")
          throw new ToolError(
            hit.message ?? "Injected failure: search failed.",
          );
        if (hit.kind === "internal") throw new Error("ECONNRESET (injected)");
        if (hit.kind === "timeout") {
          await sleep(TIMEOUT_SLEEP_MS);
          throw new ToolError("The web_search action took too long.");
        }
        if (hit.kind === "empty") return { answer: "", results: [] };
        if (hit.kind === "malformed") {
          return {
            answer: "}}}not-json{{",
            results: [
              {
                title: "\u0000bad\u0000",
                url: "not a url",
                snippet: "\ufffd\ufffd\ufffd",
              },
            ],
          };
        }
        if (hit.kind === "partial") {
          return {
            answer: "Partial fixture",
            results: [
              {
                title: `Partial: ${query}`,
                url: "https://example.com/partial",
                snippet: "",
              },
            ],
          };
        }
      }
      return {
        answer: `Fixture summary for ${query}.`,
        results: [
          {
            title: `Result 1 for ${query}`,
            url: "https://example.com/1",
            snippet: this.injectedContent ?? `${query} — example summary text.`,
          },
          {
            title: `Result 2 for ${query}`,
            url: "https://example.com/2",
            snippet: "General reference material.",
          },
          {
            title: `Result 3 for ${query}`,
            url: "https://example.com/3",
            snippet: "Additional background.",
          },
        ],
      };
    },
  };

  readonly weather = {
    current: async (place?: string): Promise<WeatherResult> => {
      let out!: WeatherResult;
      await this.guard("weather.current", () => {
        this.state.weatherCalls.push(place ?? "current location");
        const w = WEATHER[(place ?? "").toLowerCase()] ?? DEFAULT_WEATHER;
        out = {
          summary: w.summary,
          temperatureC: w.temperatureC,
          data: { ...w },
        };
      });
      return out;
    },
  };

  readonly windows = {
    control: async (
      action: WindowAction,
      app?: string,
    ): Promise<WindowControlResult> => {
      let out!: WindowControlResult;
      await this.guard("windows.control", () => {
        const k = this.key(app ?? this.state.focusedApp ?? "");
        const cur = this.state.apps[k];
        if (cur?.state !== "running") {
          throw new ToolError(
            `Couldn't ${action} ${app ?? "that window"}: it is not running.`,
          );
        }
        if (action === "focus") {
          cur.focused = true;
          this.state.focusedApp = k;
        } else if (action === "minimize") {
          cur.window = "minimized";
        } else if (action === "maximize") {
          cur.window = "maximized";
        } else if (action === "restore") {
          cur.window = "normal";
        }
        out = { done: true };
      });
      return out;
    },
  };
}

export function diffState(
  before: MockState,
  after: MockState,
): Record<string, { before: unknown; after: unknown }> {
  const diff: Record<string, { before: unknown; after: unknown }> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    const b = before[k as keyof MockState];
    const a = after[k as keyof MockState];
    if (JSON.stringify(b) !== JSON.stringify(a))
      diff[k] = { before: b, after: a };
  }
  return diff;
}
