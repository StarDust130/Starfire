/**
 * The ONE canonical definition of every Starfire capability.
 *
 * Each entry is the single source of truth for a capability's name,
 * description, arguments/schema, and basic metadata. Everything else
 * is derived or adapted from it:
 *
 *   realtime voice  → STARFIRE_FUNCTION_SPECS (functions.ts)
 *   Eve tools       → description + inputSchema (agent/tools/*.ts)
 *   execution       → executeDeviceTool (dispatch.ts)
 *
 * This is data, not a registry: it knows nothing about Eve, Electron,
 * or any OS. Platform details live behind the AgentPorts interfaces.
 */

import type { WindowAction } from "./agent.js";

export type StarfireCapabilityKind =
  /** Touches the computer through the AgentPorts. */
  | "device"
  /** Conversation-local, executed by the shared layer itself. */
  | "session";

export type StarfireCapabilityProperty = {
  type: "string";
  description?: string;
  enum?: string[];
};

export type StarfireCapability = {
  name: string;
  description: string;
  kind: StarfireCapabilityKind;
  parameters: {
    type: "object";
    properties: Record<string, StarfireCapabilityProperty>;
    required: string[];
  };
};

export const STARFIRE_CAPABILITIES: readonly StarfireCapability[] = [
  {
    name: "open_app",
    description:
      'Launch a desktop application. Use for requests like "open VS Code", "start Discord", or "launch Calculator".',
    kind: "device",
    parameters: {
      type: "object",
      properties: {
        app: { type: "string", description: "Name of the app to open." },
      },
      required: ["app"],
    },
  },
  {
    name: "close_app",
    description: "Close a running desktop application gracefully.",
    kind: "device",
    parameters: {
      type: "object",
      properties: {
        app: { type: "string", description: "Name of the app to close." },
      },
      required: ["app"],
    },
  },
  {
    name: "focus_app",
    description: "Bring a desktop application's window to the front.",
    kind: "device",
    parameters: {
      type: "object",
      properties: {
        app: { type: "string", description: "Name of the app to focus." },
      },
      required: ["app"],
    },
  },
  {
    name: "open_file",
    description: "Open a file with its default application.",
    kind: "device",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the file to open." },
      },
      required: ["path"],
    },
  },
  {
    name: "open_folder",
    description: "Open a folder in the system file manager.",
    kind: "device",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the folder to open." },
      },
      required: ["path"],
    },
  },
  {
    name: "open_url",
    description: "Open a website in the user's browser. Pass a full URL.",
    kind: "device",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full https:// URL to open." },
      },
      required: ["url"],
    },
  },
  {
    name: "clipboard",
    description:
      'Read or write the system clipboard. Use read for "what did I copy?" and write to copy text for the user.',
    kind: "device",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["read", "write"],
          description: "Whether to read or write the clipboard.",
        },
        text: {
          type: "string",
          description: "Text to copy. Required when action is write.",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "current_date_time",
    description: "Get the current local date, time, weekday, and timezone.",
    kind: "session",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "end_session",
    description:
      "End the current Starfire conversation. Use only when the user clearly says goodbye or wants to stop.",
    kind: "session",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_weather",
    description:
      "Get the current weather. Pass a place when the user asks for weather somewhere else.",
    kind: "device",
    parameters: {
      type: "object",
      properties: {
        place: {
          type: "string",
          description: "Place name. Omit for the user's current area.",
        },
      },
      required: [],
    },
  },
  {
    name: "system_info",
    description:
      "Check system status such as RAM, CPU, uptime, disk, battery, or host information.",
    kind: "device",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          enum: ["memory", "cpu", "uptime", "disk", "battery", "host"],
          description: "Which system aspect to report.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "web_search",
    description:
      "Search the web for current information, news, prices, releases, facts, and other information that may have changed.",
    kind: "device",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
      },
      required: ["query"],
    },
  },
  {
    name: "window_control",
    description:
      "Control a desktop window: focus, lower, minimize, maximize, or restore.",
    kind: "device",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "focus",
            "raise",
            "front",
            "bring-to-front",
            "bring-to-the-front",
            "activate",
            "lower",
            "back",
            "send-to-back",
            "send-behind",
            "minimize",
            "maximize",
            "restore",
            "unminimize",
          ],
          description: "The window action to perform.",
        },
        app: {
          type: "string",
          description: "App whose window to control. Omit for any window.",
        },
      },
      required: ["action"],
    },
  },
];

export const STARFIRE_CAPABILITY_NAMES: readonly string[] =
  STARFIRE_CAPABILITIES.map((capability) => capability.name);

/**
 * Looks up one canonical capability definition, failing loudly on an
 * unknown name so typos in consumers surface immediately.
 */
export function getStarfireCapability(name: string): StarfireCapability {
  const capability = STARFIRE_CAPABILITIES.find((entry) => entry.name === name);

  if (!capability) {
    throw new Error(`Unknown Starfire capability "${name}".`);
  }

  return capability;
}

/**
 * Model-facing window action synonyms mapped to the canonical
 * WindowAction the WindowPort accepts. The dispatch applies this so
 * every consumer (voice and Eve) canonicalizes identically.
 */
export const WINDOW_ACTION_SYNONYMS: Record<string, WindowAction> = {
  focus: "focus",
  raise: "focus",
  front: "focus",
  "bring-to-front": "focus",
  "bring-to-the-front": "focus",
  activate: "focus",

  lower: "lower",
  back: "lower",
  "send-to-back": "lower",
  "send-behind": "lower",

  minimize: "minimize",
  maximize: "maximize",

  restore: "restore",
  unminimize: "restore",
};
