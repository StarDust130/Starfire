import { logger } from "./lib/logger.js";
import { handleError } from "./lib/error-handler.js";

process.on("uncaughtException", (error) => {
  handleError(error, {
    fatal: true,
    source: "uncaughtException",
  });

  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  handleError(reason, {
    fatal: true,
    source: "unhandledRejection",
  });

  process.exit(1);
});

logger.info("🔥 Starfire Core started");
