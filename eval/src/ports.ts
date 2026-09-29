import type { AgentPorts } from "../../packages/contracts/src/index.ts";
import { ToolError } from "../../packages/tools/src/index.ts";

export type PortLog = {
  port: string;

  method: string;

  args: unknown[];

  ok: boolean;
};

export type SimState = {
  launchedApps: Map<string, { name: string; pid: number }>;

  clipboard: string;

  urlOpens: string[];

  searchQueries: string[];

  weatherCalls: number;

  windowActions: Array<{ action: string; app?: string }>;

  folderOpens: string[];

  fileOpens: string[];
};

let pidCounter = 1000;

export function createSimState(): SimState {
  return {
    launchedApps: new Map(),

    clipboard: "previously copied text",

    urlOpens: [],

    searchQueries: [],

    weatherCalls: 0,

    windowActions: [],

    folderOpens: [],

    fileOpens: [],
  };
}

/**
 * Real pipeline, dry-run OS: the ports simulate the OS layer (no
 * windows actually open during eval) but every call is logged and
 * every tool runs for real through the registry + agent loop.
 */
export function createEvalPorts(state: SimState, log: PortLog[]): AgentPorts {
  const record = (
    port: string,
    method: string,
    args: unknown[],
    ok: boolean,
  ): void => {
    log.push({ port, method, args, ok });
  };

  return {
    apps: {
      async open(app: string) {
        const key = app.trim().toLowerCase();

        if (key === "apple" || key === "notion" || key === "unknown") {
          record("apps", "open", [app], false);

          throw new ToolError(
            `I couldn't find an app called "${app}" — is it installed?`,
          );
        }

        pidCounter += 1;

        const entry = {
          name: app.trim().replace(/\b\w/g, (c: string) => c.toUpperCase()),

          pid: pidCounter,
        };

        state.launchedApps.set(key, entry);

        record("apps", "open", [app], true);

        return entry;
      },

      async close(app: string) {
        const key = app.trim().toLowerCase();

        const tracked = state.launchedApps.get(key);

        if (tracked) {
          state.launchedApps.delete(key);

          record("apps", "close", [app], true);

          return { closed: true, via: "pid" as const };
        }

        record("apps", "close", [app], false);

        return {
          closed: false,

          via: "not-found" as const,

          detail: `I couldn't find ${app} running right now.`,
        };
      },

      async focus(app: string) {
        record("apps", "focus", [app], true);

        return { focused: true };
      },

      async listRunning() {
        record("apps", "listRunning", [], true);

        return [...state.launchedApps.values()].map((app) => app.name);
      },
    },

    files: {
      async openFolder(p: string) {
        state.folderOpens.push(p);

        record("files", "openFolder", [p], true);

        return { opened: p };
      },

      async openFile(p: string) {
        if (p.includes("missing")) {
          record("files", "openFile", [p], false);

          throw new ToolError(`I couldn't find "${p}" — does it exist?`);
        }

        state.fileOpens.push(p);

        record("files", "openFile", [p], true);

        return { opened: p };
      },
    },

    urls: {
      async open(url: string) {
        state.urlOpens.push(url);

        record("urls", "open", [url], true);

        let host = url;

        try {
          host = new URL(url).hostname.replace(/^www\./, "");
        } catch {
          // raw url
        }

        return { opened: host };
      },
    },

    clipboard: {
      async read() {
        record("clipboard", "read", [], true);

        return state.clipboard;
      },

      async write(text: string) {
        state.clipboard = text;

        record("clipboard", "write", [text], true);
      },
    },

    system: {
      async info(query) {
        record("system", "info", [query], true);

        if (query === "memory") {
          return {
            summary: "You're using 62% of your 16 GB of RAM.",

            data: { percent: 62 },
          };
        }

        if (query === "cpu") {
          return { summary: "CPU load is about 12% across 8 cores." };
        }

        if (query === "uptime") {
          return { summary: "Your system has been up for 3h 20m." };
        }

        if (query === "disk") {
          return { summary: "Your disk is 71% full." };
        }

        if (query === "battery") {
          return { summary: "Battery is at 84% (discharging)." };
        }

        return { summary: "You're on archlinux — Linux x64." };
      },
    },

    web: {
      async search(query) {
        state.searchQueries.push(query);

        record("web", "search", [query], true);

        return {
          answer: `I found 3 results for "${query}".`,

          results: [
            { title: "Result 1", url: "https://r1", snippet: "snippet one" },

            { title: "Result 2", url: "https://r2", snippet: "snippet two" },

            { title: "Result 3", url: "https://r3", snippet: "snippet three" },
          ],
        };
      },
    },

    weather: {
      async current(place) {
        state.weatherCalls += 1;

        record("weather", "current", [place], true);

        return {
          summary: `It's 22°C in ${place ?? "your area"} right now.`,

          temperatureC: 22,
        };
      },
    },

    windows: {
      async control(action, app) {
        state.windowActions.push({ action, app });

        record("windows", "control", [action, app], true);

        return { done: true };
      },
    },
  };
}
