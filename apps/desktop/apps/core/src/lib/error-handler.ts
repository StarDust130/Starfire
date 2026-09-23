import { logger } from "./logger.js";
import { StarfireError } from "../errors/starfire-error.js";

export function normalizeError(error: unknown): StarfireError {
  if (error instanceof StarfireError) {
    return error;
  }

  if (error instanceof Error) {
    return new StarfireError({
      code: "INTERNAL_ERROR",
      message: error.message,
      safeMessage: "Something went wrong.",
      cause: error,
    });
  }

  return new StarfireError({
    code: "INTERNAL_ERROR",
    message: String(error),
    safeMessage: "Something went wrong.",
  });
}

export function handleError(
  error: unknown,
  context?: Record<string, unknown>,
): StarfireError {
  const normalized = normalizeError(error);

  logger.error(
    {
      err: normalized,
      code: normalized.code,
      retryable: normalized.retryable,
      ...context,
    },
    normalized.message,
  );

  return normalized;
}
