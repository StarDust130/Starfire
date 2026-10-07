import type { ToolName } from "@starfire/contracts";

export type ToolRisk = "low" | "medium" | "high" | "critical";

export interface ToolPolicy {
  risk: ToolRisk;

  enabled: boolean;
}

/**
 * Runtime policy for every registered tool.
 *
 * IMPORTANT:
 * The `Record<ToolName, ...>` forces every tool to have a policy.
 * Adding a new tool to TOOL_NAMES without adding its policy
 * becomes a TypeScript error.
 *
 * Confirmation itself lives in ToolManifest.danger so there is
 * only one source of truth for confirmation.
 */
export const toolPolicies: Record<ToolName, ToolPolicy> = {
  open_app: {
    risk: "low",
    enabled: true,
  },

  close_app: {
    risk: "medium",
    enabled: true,
  },

  focus_app: {
    risk: "low",
    enabled: true,
  },

  open_folder: {
    risk: "low",
    enabled: true,
  },

  open_file: {
    risk: "low",
    enabled: true,
  },

  open_url: {
    risk: "medium",
    enabled: true,
  },

  clipboard: {
    risk: "medium",
    enabled: true,
  },

  system_info: {
    risk: "medium",
    enabled: true,
  },

  web_search: {
    risk: "medium",
    enabled: true,
  },

  get_weather: {
    risk: "low",
    enabled: true,
  },

  window_control: {
    risk: "low",
    enabled: true,
  },

  current_date_time: {
    risk: "low",
    enabled: true,
  },

  end_session: {
    risk: "low",
    enabled: true,
  },
};
