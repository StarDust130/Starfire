/**
 * The shared Starfire capability dispatch: one capability name + args
 * in, a plain result (or thrown error) out. This is the single
 * execution layer every consumer goes through:
 *
 *   Eve agent  → Eve tool → HTTP /v1/tool (deviceBridge) → this
 *   voice      → realtime function call                    → this
 *   eval       → runDeviceTool                             → this
 *
 * It knows nothing about Eve, Linux, KWin, or Electron internals —
 * those live behind the AgentPorts (the platform implementation).
 */

import type { AgentPorts } from "./agent.js";

import {
  getStarfireCapability,
  WINDOW_ACTION_SYNONYMS,
} from "./capabilities.js";

/*
 * Enum constraints are derived from the canonical capability
 * definitions — the single source of truth — so runtime validation
 * can never drift from what the models are told.
 */
const SYSTEM_INFO_QUERIES: readonly string[] =
  getStarfireCapability("system_info").parameters.properties.query.enum ?? [];

const WINDOW_CONTROL_ACTIONS: readonly string[] =
  getStarfireCapability("window_control").parameters.properties.action.enum ??
  [];

function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing "${name}".`);
  }

  return value;
}

/**
 * Enforces the canonical enum schema at runtime: missing, non-string,
 * empty, or out-of-enum values are rejected before a port is touched.
 */
function requireEnum(
  args: Record<string, unknown>,
  name: string,
  allowed: readonly string[],
  tool: string,
): string {
  const value = requireString(args, name);

  if (!allowed.includes(value)) {
    throw new Error(
      `Invalid "${name}" for ${tool} — must be one of ` +
        `[${allowed.join(", ")}].`,
    );
  }

  return value;
}

function optionalString(
  args: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = args[name];

  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

/**
 * The conversation-local current_date_time implementation, shared by
 * the voice bridge and the Eve tool through the dispatch.
 */
export function currentDateTimeResult(): Record<string, unknown> {
  const DAYS = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];

  const now = new Date();

  const date = now.toLocaleDateString("en-CA");
  const time = now.toLocaleTimeString("en-GB");
  const day = DAYS[now.getDay()] ?? "unknown day";

  const timezone =
    Intl.DateTimeFormat().resolvedOptions().timeZone ?? "local timezone";

  return {
    summary: `It's ${time} on ${day}, ${date} (${timezone}).`,
    date,
    time,
    day,
    timezone,
  };
}

/**
 * The conversation-local end_session result, shared by the voice
 * bridge and the Eve tool through the dispatch.
 */
export function endSessionResult(): Record<string, unknown> {
  return {
    summary: "Waving goodbye and going to sleep. See you soon! ♡",
    endSession: true,
  };
}

export async function executeDeviceTool(
  ports: AgentPorts,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  switch (tool) {
    case "open_app":
      return ports.apps.open(requireString(args, "app"));

    case "close_app":
      return ports.apps.close(requireString(args, "app"));

    case "focus_app":
      return ports.apps.focus(requireString(args, "app"));

    case "open_file":
      return ports.files.openFile(requireString(args, "path"));

    case "open_folder":
      return ports.files.openFolder(requireString(args, "path"));

    case "open_url":
      return ports.urls.open(requireString(args, "url"));

    case "clipboard": {
      const action = args.action;

      if (action === "read") {
        return { text: await ports.clipboard.read() };
      }

      if (action === "write") {
        await ports.clipboard.write(requireString(args, "text"));

        return undefined;
      }

      throw new Error('Clipboard needs an action: "read" or "write".');
    }

    case "clipboard_read":
      return { text: await ports.clipboard.read() };

    case "clipboard_write": {
      await ports.clipboard.write(requireString(args, "text"));

      return undefined;
    }

    case "system_info":
      return ports.system.info(
        requireEnum(args, "query", SYSTEM_INFO_QUERIES, "system_info") as never,
      );

    case "web_search":
      return ports.web.search(requireString(args, "query"));

    case "get_weather":
      return ports.weather.current(optionalString(args, "place"));

    case "window_control": {
      const raw = requireEnum(
        args,
        "action",
        WINDOW_CONTROL_ACTIONS,
        "window_control",
      );

      return ports.windows.control(
        (WINDOW_ACTION_SYNONYMS[raw] ?? raw) as never,
        optionalString(args, "app"),
      );
    }

    case "current_date_time":
      return currentDateTimeResult();

    case "end_session":
      return endSessionResult();

    default:
      throw new Error(`Unknown device tool "${tool}".`);
  }
}
