export type ToolDanger =
  /**
   * Runtime confirmation requirement.
   * "safe" runs immediately.
   * "confirm" requires explicit user approval.
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
 * JSON-schema subset for a tool's arguments.
 * This exact shape is embedded into the realtime session config.
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
  "open_url",
  "clipboard",
  "system_info",
  "web_search",
  "get_weather",
  "window_control",
  "current_date_time",
  "end_session",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export type ToolManifest = {
  name: ToolName;

  description: string;

  /**
   * Runtime confirmation hint.
   * The Registry enforces this value.
   */
  danger: ToolDanger;

  parameters: ToolParameterSchema;
};

/**
 * A tool invocation coming from the model.
 * `name` stays a plain string so unknown tools can fail gracefully.
 */
export type ToolCall = {
  callId: string;

  name: string;

  args: unknown;
};

/**
 * What a tool handler produces on success.
 */
export type ToolOutput = {
  summary: string;

  data?: Record<string, unknown>;
};

/**
 * What the agent returns to the model for one call.
 * Never expose raw stack traces to the model/user.
 */
export type ToolResult = {
  callId: string;
  ok: boolean;
  summary: string;
  data?: Record<string, unknown>;

  error?:
    | "unknown-tool"
    | "invalid-args"
    | "policy-denied"
    | "confirmation-required"
    | "confirmation-denied"
    | "tool-error"
    | "internal-error";
};

export type ToolConfirmationRequest = {
  tool: ToolName;
  args: Record<string, unknown>;
  reason: string;
};

export type ToolContext = {
  log?: (message: string) => void;

  /**
   * Future permission UI.
   * Must return true only after explicit user approval.
   */
  confirm?: (request: ToolConfirmationRequest) => Promise<boolean>;
};

/*
 * ---------------------------------------------------
 * OS PORTS
 * ---------------------------------------------------
 * The tools are pure logic; these ports are the hands.
 * Implemented in apps/desktop/electron/agent and faked in tests.
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

  listRunning(): Promise<string[]>;
};

export type FilePort = {
  openFolder(path: string): Promise<{ opened: string }>;

  openFile(path: string): Promise<{ opened: string }>;
};

export type UrlPort = {
  open(url: string): Promise<{ opened: string }>;
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

  urls: UrlPort;

  clipboard: ClipboardPort;

  system: SystemPort;

  web: WebPort;

  weather: WeatherPort;

  windows: WindowPort;
};
