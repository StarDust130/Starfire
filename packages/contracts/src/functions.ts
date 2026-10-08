/**
 * Model-facing function specs for Starfire's platform capabilities.
 *
 * These describe the SAME capabilities as the Eve tools in
 * `agent/tools/*.ts`, in the JSON-schema form realtime models require
 * in `session.update`. Consumers: the Electron realtime voice bridge
 * and the eval driver.
 *
 * This is data, not a registry: Eve owns tool discovery, validation,
 * and execution for the agent path.
 */

export type StarfireFunctionSpec = {
  type: "function";
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<
      string,
      { type: string; description?: string; enum?: string[] }
    >;
    required: string[];
  };
};

export const STARFIRE_FUNCTION_SPECS: StarfireFunctionSpec[] = [
  {
    type: "function",
    name: "open_app",
    description:
      'Launch a desktop application. Use for requests like "open VS Code", "start Discord", or "launch Calculator".',
    parameters: {
      type: "object",
      properties: {
        app: { type: "string", description: "Name of the app to open." },
      },
      required: ["app"],
    },
  },
  {
    type: "function",
    name: "close_app",
    description: "Close a running desktop application gracefully.",
    parameters: {
      type: "object",
      properties: {
        app: { type: "string", description: "Name of the app to close." },
      },
      required: ["app"],
    },
  },
  {
    type: "function",
    name: "focus_app",
    description: "Bring a desktop application's window to the front.",
    parameters: {
      type: "object",
      properties: {
        app: { type: "string", description: "Name of the app to focus." },
      },
      required: ["app"],
    },
  },
  {
    type: "function",
    name: "open_file",
    description: "Open a file with its default application.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the file to open." },
      },
      required: ["path"],
    },
  },
  {
    type: "function",
    name: "open_folder",
    description: "Open a folder in the system file manager.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the folder to open." },
      },
      required: ["path"],
    },
  },
  {
    type: "function",
    name: "open_url",
    description: "Open a website in the user's browser. Pass a full URL.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full https:// URL to open." },
      },
      required: ["url"],
    },
  },
  {
    type: "function",
    name: "clipboard",
    description:
      'Read or write the system clipboard. Use read for "what did I copy?" and write to copy text for the user.',
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
    type: "function",
    name: "current_date_time",
    description: "Get the current local date, time, weekday, and timezone.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "end_session",
    description:
      "End the current Starfire conversation. Use only when the user clearly says goodbye or wants to stop.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "get_weather",
    description:
      "Get the current weather. Pass a place when the user asks for weather somewhere else.",
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
    type: "function",
    name: "system_info",
    description:
      "Check system status such as RAM, CPU, uptime, disk, battery, or host information.",
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
    type: "function",
    name: "web_search",
    description:
      "Search the web for current information, news, prices, releases, facts, and other information that may have changed.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "window_control",
    description:
      "Control a desktop window: focus, lower, minimize, maximize, or restore.",
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

export const STARFIRE_TOOL_NAMES = STARFIRE_FUNCTION_SPECS.map(
  (spec) => spec.name,
);
