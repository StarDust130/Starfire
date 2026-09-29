/*
 * ---------------------------------------------------
 * AGENT & TOOL CONTRACTS
 * ---------------------------------------------------
 * Shared by apps/desktop (voice + executors), packages/tools
 * (registry) and apps/core (agent loop). Types only — no runtime.
 *
 * The tool manifest is the SINGLE SOURCE OF TRUTH: the exact same
 * object is embedded into the realtime session config for the model
 * AND used by the registry to validate arguments.
 */

export type ToolDanger =
  /**
   * Runs immediately. V0: everything is "safe" — the permission UI
   * comes later, but the flag is declared now so nothing changes
   * structurally when it arrives.
   */
  "safe" | "confirm";

export type ToolParameterType = "string" | "number" | "boolean";

export type ToolParameter = {
  type: ToolParameterType;

  /**
   * Read by the model — a good description is what makes Qwen pick
   * the right tool for "open VS Code".
   */
  description: string;

  enum?: string[];
};

/**
 * JSON-schema subset for a tool's arguments. This exact shape is
 * embedded into the realtime session config.
 */
export type ToolParameterSchema = {
  type: "object";

  properties: Record<string, ToolParameter>;

  required: string[];
};

export const TOOL_NAMES = [
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
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export type ToolManifest = {
  name: ToolName;

  description: string;

  danger: ToolDanger;

  parameters: ToolParameterSchema;
};

/**
 * A tool invocation coming from the model. `name` is a plain string
 * so the registry can answer unknown tools gracefully instead of the
 * protocol layer crashing.
 */
export type ToolCall = {
  callId: string;

  name: string;

  args: unknown;
};

/**
 * What a tool handler produces on success.
 * `summary` is the human sentence the model speaks from.
 */
export type ToolOutput = {
  summary: string;

  data?: Record<string, unknown>;
};

/**
 * What the agent returns to the model for one call.
 * `error` is a machine-readable kind, never raw stack traces.
 */
export type ToolResult = {
  callId: string;

  ok: boolean;

  summary: string;

  data?: Record<string, unknown>;

  error?: "unknown-tool" | "invalid-args" | "tool-error" | "internal-error";
};

export type ToolContext = {
  log?: (message: string) => void;
};

/*
 * ---------------------------------------------------
 * OS PORTS
 * ---------------------------------------------------
 * The tools are pure logic; these ports are the hands. Implemented
 * in apps/desktop/electron/agent (the only place allowed to touch
 * the OS), faked in tests.
 *
 * Ports throw ToolError (from @starfire/tools) for user-friendly
 * failures; anything else becomes a generic failure.
 */

export type OpenedApp = {
  /** Resolved friendly name, e.g. "VS Code". */
  name: string;

  pid?: number;
};

export type CloseOutcome = {
  closed: boolean;

  via: "pid" | "name" | "not-found";

  detail?: string;
};

export type FocusOutcome = {
  focused: boolean;

  detail?: string;
};

export type AppPort = {
  open(app: string): Promise<OpenedApp>;

  close(app: string): Promise<CloseOutcome>;

  focus(app: string): Promise<FocusOutcome>;
};

export type FilePort = {
  openFolder(path: string): Promise<{ opened: string }>;

  openFile(path: string): Promise<{ opened: string }>;
};

export type ClipboardPort = {
  read(): Promise<string>;

  write(text: string): Promise<void>;
};

export type SystemInfoQuery =
  | "memory"
  | "cpu"
  | "uptime"
  | "disk"
  | "battery"
  | "host";

export type SystemInfoResult = {
  summary: string;

  data?: Record<string, unknown>;
};

export type SystemPort = {
  info(query: SystemInfoQuery): Promise<SystemInfoResult>;
};

export type WebSearchResultItem = {
  title: string;

  url: string;

  snippet: string;
};

export type WebSearchResult = {
  answer: string;

  results: WebSearchResultItem[];
};

export type WebPort = {
  search(query: string): Promise<WebSearchResult>;
};

export type WeatherResult = {
  summary: string;

  temperatureC: number | null;

  data?: Record<string, unknown>;
};

export type WeatherPort = {
  current(place?: string): Promise<WeatherResult>;
};

export type WindowAction =
  | "focus"
  | "lower"
  | "minimize"
  | "maximize"
  | "restore";

export type WindowControlResult = {
  done: boolean;

  detail?: string;
};

export type WindowPort = {
  control(action: WindowAction, app?: string): Promise<WindowControlResult>;
};

export type AgentPorts = {
  apps: AppPort;

  files: FilePort;

  clipboard: ClipboardPort;

  system: SystemPort;

  web: WebPort;

  weather: WeatherPort;

  windows: WindowPort;
};
