import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",

  base: {
    service: "starfire-core",
  },

  redact: {
    paths: [
      "password",
      "token",
      "accessToken",
      "refreshToken",
      "apiKey",
      "authorization",
      "*.password",
      "*.token",
      "*.apiKey",
      "*.authorization",
    ],
    censor: "[REDACTED]",
  },

  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:standard",
            ignore: "pid,hostname",
          },
        },
      }),
});

export function createTaskLogger(taskId: string) {
  return logger.child({ taskId });
}
