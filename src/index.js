"use strict";

const { loadConfig, ConfigError } = require("./config");
const { runJob } = require("./job");
const { HttpRequestError } = require("./httpClient");
const { NotificationError } = require("./notifier");
const { logger } = require("./logger");

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", {
    reason: reason instanceof Error ? reason : new Error(String(reason))
  });
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", { error });
  process.exit(1);
});

async function main() {
  try {
    const config = loadConfig();
    await runJob(config);
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.error("Configuration error", { error: error.message });
      process.exitCode = 1;
      return;
    }

    if (error instanceof HttpRequestError) {
      logger.error("HTTP request failed", {
        error: error.message,
        status: error.status,
        body: error.body
      });
      process.exitCode = 1;
      return;
    }

    if (error instanceof NotificationError) {
      logger.error("Notification failed", {
        error: error.message,
        status: error.status,
        body: error.body
      });
      process.exitCode = 1;
      return;
    }

    logger.error("Unexpected job failure", { error });
    process.exitCode = 1;
  }
}

main();
