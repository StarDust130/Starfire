import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentPorts,
  CloseOutcome,
  FocusOutcome,
  OpenedApp,
  SystemInfoQuery,
  SystemInfoResult,
  WeatherResult,
  WebSearchResult,
  WindowAction,
  WindowControlResult,
} from "@starfire/contracts";

import { ToolError } from "@starfire/tools";
import { clipboard, shell } from "electron";

import { createExaSearchAdapter } from "./exa-search.js";

import { createKwinWindowController } from "./kwin-windows.js";

/*
 * ---------------------------------------------------
 * REAL OS PORTS (Electron main process only)
 * ---------------------------------------------------
 * Safety rules:
 *  - never a shell: spawn(binary, args) — no string commands
 *  - denylist for dangerous binaries
 *  - file tools restricted to the user's home folder
 *  - close is GRACEFUL (SIGTERM, like clicking X) — never SIGKILL
 *  - window control goes through KWin scripting (the compositor
 *    performs every action — Wayland-safe on KDE)
 *  - websites open through shell.openExternal (the OS default
 *    browser, Wayland-safe)
 */

const DENYLIST = new Set([
  "sudo",
  "su",
  "doas",
  "rm",
  "sh",
  "bash",
  "zsh",
  "fish",
  "kill",
  "pkill",
  "killall",
  "shutdown",
  "reboot",
  "poweroff",
  "systemctl",
  "mkfs",
  "dd",
  "chmod",
  "chown",
]);

const APP_ALIASES: Record<string, string[]> = {
  "vs code": ["code"],
  vscode: ["code"],
  code: ["code"],
  discord: ["discord"],
  firefox: ["firefox"],
  chrome: ["google-chrome-stable", "google-chrome", "chromium"],
  "google chrome": ["google-chrome-stable", "google-chrome", "chromium"],
  chromium: ["chromium"],
  brave: ["brave", "brave-browser"],
  browser: ["brave", "firefox", "google-chrome-stable", "chromium"],
  notion: ["notion-app", "notion"],
  telegram: ["telegram-desktop"],
  terminal: ["kitty", "konsole", "alacritty", "gnome-terminal"],
  konsole: ["konsole"],
  kitty: ["kitty"],
  alacritty: ["alacritty"],
  files: ["dolphin", "nautilus"],
  dolphin: ["dolphin"],
  nautilus: ["nautilus"],
  calculator: ["kcalc", "gnome-calculator"],
  spotify: ["spotify"],
  vlc: ["vlc"],
  mpv: ["mpv"],
  steam: ["steam"],
  gimp: ["gimp"],
  krita: ["krita"],
  obs: ["obs"],
  slack: ["slack"],
  thunderbird: ["thunderbird"],
  settings: ["systemsettings", "gnome-control-center"],
};

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function prettify(name: string): string {
  const trimmed = name.trim();

  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function resolveCandidates(app: string): string[] {
  const key = normalizeName(app);

  const candidates = APP_ALIASES[key] ?? [
    key.replace(/\s+/g, "-"),
    key.replace(/\s+/g, ""),
  ];

  return [...new Set(candidates)];
}

function assertAllowed(key: string): void {
  if (DENYLIST.has(key)) {
    throw new ToolError("I'm not allowed to launch that.");
  }
}

function which(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("which", [command], (error) => resolve(!error));
  });
}

function spawnDetached(
  command: string,
  args: string[] = [],
): Promise<number | null> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
      });

      child.once("error", () => resolve(null));

      child.once("spawn", () => resolve(child.pid ?? null));

      child.unref();
    } catch {
      resolve(null);
    }
  });
}

function pgrepFirst(name: string): Promise<number | null> {
  const attempt = (args: string[]): Promise<number | null> =>
    new Promise((resolve) => {
      execFile("pgrep", args, (error, stdout) => {
        if (error) {
          resolve(null);

          return;
        }

        const first = stdout.split("\n")[0]?.trim();

        const pid = first ? Number.parseInt(first, 10) : Number.NaN;

        resolve(Number.isFinite(pid) ? pid : null);
      });
    });

  return attempt(["-x", name]).then((pid) =>
    pid !== null ? pid : attempt(["-f", name]),
  );
}

function pidAlive(pid: number | undefined): pid is number {
  if (pid === undefined) {
    return false;
  }

  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

function expandHome(target: string): string {
  if (target === "~") {
    return os.homedir();
  }

  if (target.startsWith("~/")) {
    return path.join(os.homedir(), target.slice(2));
  }

  return target;
}

async function resolveHomePath(
  raw: string,
  kind: "folder" | "file",
): Promise<string> {
  const input = raw.trim();

  if (!input) {
    throw new ToolError("Please provide a file or folder path.");
  }

  const home = await fs.realpath(os.homedir());

  const expanded = expandHome(input);

  /*
   * Bare paths like "Documents" mean a path relative
   * to the user's home, not Electron's working directory.
   */
  const candidate = path.isAbsolute(expanded)
    ? expanded
    : path.join(home, expanded);

  /*
   * realpath follows symlinks.
   *
   * This is the important security check:
   * /home/thor/link -> /outside
   * becomes /outside here and gets rejected.
   */
  const resolved = await fs.realpath(candidate).catch(() => null);

  if (!resolved) {
    throw new ToolError(`I couldn't find "${raw}" — does it exist?`);
  }

  if (resolved !== home && !resolved.startsWith(home + path.sep)) {
    throw new ToolError(
      "For safety I can only open things inside your home folder for now.",
    );
  }

  const stat = await fs.stat(resolved).catch(() => null);

  if (!stat) {
    throw new ToolError(`I couldn't find "${raw}" — does it exist?`);
  }

  const isDir = stat.isDirectory();

  if (kind === "folder" && !isDir) {
    throw new ToolError(`"${raw}" is a file, not a folder.`);
  }

  if (kind === "file" && isDir) {
    throw new ToolError(`"${raw}" is a folder, not a file.`);
  }

  return resolved;
}

function humanizeUptime(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86400);

  const hours = Math.floor((totalSeconds % 86400) / 3600);

  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (days > 0) {
    return `${days}d ${hours}h`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  return `${minutes}m`;
}

async function fetchJson<T>(url: string, timeoutMs = 6000): Promise<T> {
  const controller = new AbortController();

  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      throw new ToolError("A web service I needed didn't respond properly.");
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export function createElectronPorts(): AgentPorts {
  /*
   * Apps Starfire launched herself — remembered so close_app can
   * target them precisely and gracefully.
   */
  const opened = new Map<string, OpenedApp>();

  const kwin = createKwinWindowController(
    {
      read: () => clipboard.readText(),

      write: (text: string) => clipboard.writeText(text),
    },

    (message) => console.log(`[Starfire Voice] ${message}`),
  );

  return {
    apps: {
      async open(app: string): Promise<OpenedApp> {
        const key = normalizeName(app);

        assertAllowed(key);

        const tracked = opened.get(key);

        if (tracked && pidAlive(tracked.pid)) {
          return tracked;
        }

        for (const candidate of resolveCandidates(app)) {
          assertAllowed(normalizeName(candidate));

          if (!(await which(candidate))) {
            continue;
          }

          const pid = await spawnDetached(candidate);

          if (pid === null) {
            continue;
          }

          const openedApp: OpenedApp = {
            name: prettify(app),

            pid,
          };

          opened.set(key, openedApp);

          return openedApp;
        }

        throw new ToolError(
          `I couldn't find an app called "${app}" — is it installed?`,
        );
      },

      async close(app: string): Promise<CloseOutcome> {
        const key = normalizeName(app);

        assertAllowed(key);

        const tracked = opened.get(key);

        if (tracked && pidAlive(tracked.pid)) {
          try {
            process.kill(tracked.pid, "SIGTERM");
          } catch {
            // died in the meantime — fall through to the search
          }

          opened.delete(key);

          return {
            closed: true,

            via: "pid",
          };
        }

        for (const candidate of resolveCandidates(app)) {
          assertAllowed(normalizeName(candidate));

          const pid = await pgrepFirst(candidate);

          if (pid === null) {
            continue;
          }

          try {
            process.kill(pid, "SIGTERM");

            return {
              closed: true,

              via: "name",
            };
          } catch {
            // try the next candidate
          }
        }

        return {
          closed: false,

          via: "not-found",

          detail: `I couldn't find ${prettify(app)} running right now.`,
        };
      },

      async focus(app: string): Promise<FocusOutcome> {
        const outcome = await kwin.perform("focus", normalizeName(app));

        if (!outcome.done) {
          return {
            focused: false,

            detail: outcome.detail ?? `I couldn't bring ${app} to the front.`,
          };
        }

        return {
          focused: true,
        };
      },

      async listRunning(): Promise<string[]> {
        const names = [...opened.entries()]
          .filter(([, app]) => pidAlive(app.pid))
          .map(([key]) => prettify(key));

        return names;
      },
    },

    files: {
      async openFolder(folderPath: string) {
        const target = await resolveHomePath(folderPath, "folder");

        const pid = await spawnDetached("xdg-open", [target]);

        if (pid === null) {
          throw new ToolError("I couldn't open the folder just now.");
        }

        return {
          opened: path.basename(target) || target,
        };
      },

      async openFile(filePath: string) {
        const target = await resolveHomePath(filePath, "file");

        const pid = await spawnDetached("xdg-open", [target]);

        if (pid === null) {
          throw new ToolError("I couldn't open the file just now.");
        }

        return {
          opened: path.basename(target) || target,
        };
      },
    },

    urls: {
      async open(url: string) {
        try {
          await shell.openExternal(url);
        } catch {
          throw new ToolError("I couldn't open that website just now.");
        }

        let host = url;

        try {
          host = new URL(url).hostname.replace(/^www\./, "");
        } catch {
          // keep the raw url as the spoken name
        }

        return {
          opened: host,
        };
      },
    },

    clipboard: {
      async read() {
        try {
          return clipboard.readText();
        } catch {
          throw new ToolError("I couldn't read your clipboard right now.");
        }
      },

      async write(text: string) {
        try {
          clipboard.writeText(text);
        } catch {
          throw new ToolError("I couldn't write to your clipboard right now.");
        }
      },
    },

    system: {
      async info(query: SystemInfoQuery): Promise<SystemInfoResult> {
        if (query === "memory") {
          const total = os.totalmem();

          const free = os.freemem();

          const totalGb = total / 1024 ** 3;

          const percent = Math.round(((total - free) / total) * 100);

          return {
            summary: `You're using ${percent}% of your ${totalGb.toFixed(0)} GB of RAM.`,

            data: { percent },
          };
        }

        if (query === "cpu") {
          const cores = os.cpus().length || 1;

          const percent = Math.min(
            100,
            Math.round((os.loadavg()[0] / cores) * 100),
          );

          return {
            summary: `CPU load is about ${percent}% across ${cores} cores.`,

            data: { percent, cores },
          };
        }

        if (query === "uptime") {
          return {
            summary: `Your system has been up for ${humanizeUptime(os.uptime())}.`,

            data: { uptimeSeconds: os.uptime() },
          };
        }

        if (query === "disk") {
          const stats = await fs.statfs("/").catch(() => null);

          if (!stats) {
            throw new ToolError("I couldn't check the disk right now.");
          }

          const total = Number(stats.blocks) * Number(stats.bsize);

          const free = Number(stats.bfree) * Number(stats.bsize);

          const percent = Math.round(((total - free) / total) * 100);

          return {
            summary: `Your disk is ${percent}% full.`,

            data: { percent },
          };
        }

        if (query === "battery") {
          const supplies = await fs
            .readdir("/sys/class/power_supply")
            .catch(() => []);

          const battery = supplies.find((entry) => entry.startsWith("BAT"));

          if (!battery) {
            return {
              summary: "I couldn't find a battery — desktop mode it is.",
            };
          }

          const capacity = await fs
            .readFile(`/sys/class/power_supply/${battery}/capacity`, "utf8")
            .then((value) => value.trim())
            .catch(() => "?");

          const status = await fs
            .readFile(`/sys/class/power_supply/${battery}/status`, "utf8")
            .then((value) => value.trim().toLowerCase())
            .catch(() => "unknown");

          return {
            summary: `Battery is at ${capacity}% (${status}).`,
          };
        }

        return {
          summary: `You're on ${os.hostname()} — ${os.type()} ${os.release()} (${os.arch()}).`,
        };
      },
    },

    web: {
      async search(query: string): Promise<WebSearchResult> {
        const adapter = createExaSearchAdapter(process.env.EXA_API_KEY);

        const result = await adapter.search(query);

        return result as WebSearchResult;
      },
    },

    weather: {
      async current(place?: string): Promise<WeatherResult> {
        let latitude: number;

        let longitude: number;

        let placeName: string;

        if (place) {
          const geo = await fetchJson<{
            results?: Array<{
              latitude: number;
              longitude: number;
              name: string;
            }>;
          }>(
            `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1`,
          );

          const hit = geo.results?.[0];

          if (!hit) {
            throw new ToolError(`I couldn't find a place called "${place}".`);
          }

          latitude = hit.latitude;

          longitude = hit.longitude;

          placeName = hit.name;
        } else {
          const ip = await fetchJson<{ lat?: number; lon?: number } | null>(
            "http://ip-api.com/json/",
          );

          if (!ip?.lat || !ip?.lon) {
            throw new ToolError("I couldn't figure out your location.");
          }

          latitude = ip.lat;

          longitude = ip.lon;

          placeName = "your area";
        }

        const weather = await fetchJson<{
          current?: { temperature_2m?: number; weather_code?: number };
        }>(
          `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code`,
        );

        const temperature = weather.current?.temperature_2m;

        if (typeof temperature !== "number") {
          throw new ToolError("I couldn't get the weather right now.");
        }

        return {
          summary: `It's ${Math.round(temperature)}°C in ${placeName} right now.`,

          temperatureC: temperature,

          data: {
            place: placeName,
            weatherCode: weather.current?.weather_code,
          },
        };
      },
    },

    windows: {
      async control(
        action: WindowAction,
        app?: string,
      ): Promise<WindowControlResult> {
        return kwin.perform(action, app ? normalizeName(app) : null);
      },
    },
  };
}
