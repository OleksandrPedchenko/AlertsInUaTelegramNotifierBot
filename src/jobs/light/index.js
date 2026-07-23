"use strict";

const dotenv = require("dotenv");
const { ConfigError } = require("../../lib/config");
const { HttpRequestError } = require("../../lib/httpClient");
const { createLoggerFromEnv } = require("../../lib/logger");
const { NotificationError } = require("../../lib/telegramNotifier");
const { runPluginJob } = require("../../lib/runner");
const { lightPlugin } = require("./plugin");

dotenv.config({ quiet: true });

async function runLightJob(config, options = {}) {
  return runPluginJob(lightPlugin, process.env, {
    ...options,
    config
  });
}

async function main(options = {}) {
  const logger = options.logger || createLoggerFromEnv(process.env);

  try {
    await runPluginJob(lightPlugin, process.env, {
      ...options,
      logger
    });
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
  } finally {
    await logger.flush?.();
  }
}

if (require.main === module) {
  process.on("unhandledRejection", async (reason) => {
    const logger = createLoggerFromEnv(process.env);
    logger.error("Unhandled promise rejection", {
      reason: reason instanceof Error ? reason : new Error(String(reason))
    });
    await logger.flush?.();
  });

  process.on("uncaughtException", async (error) => {
    const logger = createLoggerFromEnv(process.env);
    logger.error("Uncaught exception", { error });
    await logger.flush?.();
    process.exit(1);
  });

  main();
}

module.exports = {
  lightPlugin,
  main,
  runLightJob
};
