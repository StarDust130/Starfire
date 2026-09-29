import type { AgentPorts } from "@starfire/contracts";

import type { ToolDefinition } from "../registry.js";

import { createClipboardTool } from "./clipboard.js";

import { createCloseAppTool } from "./close-app.js";

import { createCurrentDateTimeTool } from "./current-date-time.js";

import { createEndSessionTool } from "./end-session.js";

import { createFocusAppTool } from "./focus-app.js";

import { createGetWeatherTool } from "./get-weather.js";

import { createOpenAppTool } from "./open-app.js";

import { createOpenFileTool } from "./open-file.js";

import { createOpenFolderTool } from "./open-folder.js";

import { createOpenUrlTool } from "./open-url.js";

import { createSystemInfoTool } from "./system-info.js";

import { createWebSearchTool } from "./web-search.js";

import { createWindowControlTool } from "./window-control.js";

/**
 * The full V0 toolset. Adding tool #20 later = one new file in this
 * folder + one line here.
 */
export function createDefaultTools(ports: AgentPorts): ToolDefinition[] {
  return [
    createOpenAppTool(ports),

    createCloseAppTool(ports),

    createFocusAppTool(ports),

    createOpenFolderTool(ports),

    createOpenFileTool(ports),

    createOpenUrlTool(ports.urls),

    createClipboardTool(ports),

    createSystemInfoTool(ports),

    createWebSearchTool(ports.web),

    createGetWeatherTool(ports.weather),

    createWindowControlTool(ports.windows),

    createCurrentDateTimeTool(),

    createEndSessionTool(),
  ];
}
