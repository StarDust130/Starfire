/**
 * Starfire platform contracts.
 *
 * Eve owns the agent runtime and tool orchestration.
 * These types only describe what Starfire's local computer can do.
 */

export type OpenedApp = {
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

/**
 * All local computer capabilities exposed by Starfire.
 *
 * Eve does not know about Linux, Windows, macOS, KWin, Electron, etc.
 * Those details live behind these interfaces.
 */
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
