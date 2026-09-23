export type ErrorCode =
  | "INTERNAL_ERROR"
  | "CONFIG_INVALID"
  | "VALIDATION_FAILED"
  | "PERMISSION_DENIED"
  | "TOOL_NOT_FOUND"
  | "TOOL_EXECUTION_FAILED"
  | "MODEL_FAILED";

export interface StarfireErrorOptions {
  code: ErrorCode;
  message: string;
  safeMessage?: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class StarfireError extends Error {
  readonly code: ErrorCode;
  readonly safeMessage: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(options: StarfireErrorOptions) {
    super(options.message, {
      cause: options.cause,
    });

    this.name = "StarfireError";
    this.code = options.code;
    this.safeMessage = options.safeMessage ?? options.message;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export class ToolExecutionError extends StarfireError {
  constructor(toolName: string, cause: unknown) {
    super({
      code: "TOOL_EXECUTION_FAILED",
      message: `Tool "${toolName}" failed`,
      safeMessage: `I couldn't complete the ${toolName} action.`,
      retryable: true,
      details: { toolName },
      cause,
    });
  }
}

export class PermissionError extends StarfireError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({
      code: "PERMISSION_DENIED",
      message,
      safeMessage: "I don't have permission to perform that action.",
      retryable: false,
      details,
    });
  }
}
