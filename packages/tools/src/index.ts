import type { ToolRequest, ToolResult } from "@starfire/contracts";

export interface Tool {
  readonly name: string;
  readonly description: string;

  execute(request: ToolRequest): Promise<ToolResult>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }

    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): readonly Tool[] {
    return [...this.tools.values()];
  }
}
