export type ToolRisk = "low" | "medium" | "high" | "critical";

export interface ToolPolicy {
  risk: ToolRisk;
  requiresConfirmation: boolean;
}

export const toolPolicies = {
  open_app: {
    risk: "low",
    requiresConfirmation: false,
  },

  read_file: {
    risk: "medium",
    requiresConfirmation: false,
  },

  edit_file: {
    risk: "medium",
    requiresConfirmation: true,
  },

  delete_file: {
    risk: "high",
    requiresConfirmation: true,
  },

  shell: {
    risk: "critical",
    requiresConfirmation: true,
  },
} satisfies Record<string, ToolPolicy>;
