"use strict";

const { createEnvReader } = require("./config");
const { requestWithRetry } = require("./httpClient");
const { acquireRunLock } = require("./lock");
const { createLogger } = require("./logger");
const { readJobState, writeJobState } = require("./stateStore");
const { sendTelegramMessage } = require("./telegramNotifier");

function createFallbackLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    async flush() {}
  };
}

function getPreviousFingerprint(plugin, previousRecord, config) {
  if (!previousRecord) {
    return null;
  }

  if (typeof plugin.getPreviousStateFingerprint === "function") {
    return plugin.getPreviousStateFingerprint(previousRecord.state, config, previousRecord);
  }

  if (previousRecord.fingerprint) {
    return previousRecord.fingerprint;
  }

  if (previousRecord.state && typeof plugin.getStateFingerprint === "function") {
    return plugin.getStateFingerprint(previousRecord.state);
  }

  return null;
}

function normalizeNotifications(notificationOutput) {
  if (!notificationOutput) {
    return [];
  }

  const rawNotifications = Array.isArray(notificationOutput)
    ? notificationOutput
    : [notificationOutput];

  return rawNotifications
    .map((notification) => {
      if (!notification) {
        return null;
      }

      if (typeof notification === "string") {
        return {
          type: "default",
          text: notification
        };
      }

      if (typeof notification === "object" && typeof notification.text === "string") {
        return {
          type: notification.type || "default",
          text: notification.text
        };
      }

      return null;
    })
    .filter((notification) => notification && notification.text);
}

async function runPluginJob(plugin, env = process.env, options = {}) {
  const readers = createEnvReader(env, { cwd: options.cwd || process.cwd() });
  const config =
    options.config || plugin.loadConfig(env, readers);
  const ownsLogger = !options.logger;
  const logger =
    options.logger ||
    createLogger({
      cwd: readers.cwd,
      fetchImpl: options.fetchImpl,
      ...(config.log || {})
    });

  const lockFilePath = plugin.getLockFilePath(config);
  const releaseLock = await acquireRunLock(lockFilePath);
  if (!releaseLock) {
    logger.warn("Another job instance is already running; skipping this run", {
      jobName: plugin.name,
      lockFilePath
    });
    if (ownsLogger) {
      await logger.flush?.();
    }
    return { jobName: plugin.name, skipped: true };
  }

  try {
    const stateFilePath = plugin.getStateFilePath(config);
    const initialStateKey = plugin.getStateKey(config);
    let previousRecord = initialStateKey
      ? await readJobState(stateFilePath, initialStateKey)
      : null;

    const deps = {
      logger,
      requestWithRetry,
      previousRecord,
      previousState: previousRecord ? previousRecord.state : null,
      fetchImpl: options.fetchImpl
    };

    logger.info("Starting plugin job", {
      jobName: plugin.name,
      stateFilePath,
      lockFilePath
    });

    const currentState = await plugin.fetchCurrent(config, deps);
    const stateKey = plugin.getStateKey(config, currentState);

    if (stateKey !== initialStateKey) {
      previousRecord = await readJobState(stateFilePath, stateKey);
    }

    const previousState = previousRecord ? previousRecord.state : null;
    const previousFingerprint = getPreviousFingerprint(plugin, previousRecord, config);
    const currentFingerprint = plugin.getStateFingerprint(currentState);
    const changed = previousFingerprint !== currentFingerprint;

    await writeJobState(stateFilePath, stateKey, currentState, currentFingerprint, {
      jobName: plugin.name
    });

    const shouldNotify =
      typeof plugin.shouldNotify === "function"
        ? plugin.shouldNotify({
            previousState,
            previousRecord,
            currentState,
            currentFingerprint,
            previousFingerprint,
            changed,
            config
          })
        : changed;

    if (!shouldNotify) {
      logger.info("State unchanged; notification skipped", {
        jobName: plugin.name,
        stateKey,
        stateFilePath
      });
      return {
        jobName: plugin.name,
        skipped: false,
        notified: false,
        changed
      };
    }

    const notificationOutput = await plugin.buildNotification({
      previousState,
      previousRecord,
      currentState,
      currentFingerprint,
      previousFingerprint,
      changed,
      config,
      deps
    });
    const notifications = normalizeNotifications(notificationOutput);

    if (notifications.length === 0) {
      logger.info("Notification text is empty; notification skipped", {
        jobName: plugin.name,
        stateKey
      });
      return {
        jobName: plugin.name,
        skipped: false,
        notified: false,
        changed
      };
    }

    for (const notification of notifications) {
      await sendTelegramMessage(notification.text, config.telegram, {
        fetchImpl: options.fetchImpl,
        logger
      });
    }

    if (typeof plugin.afterNotificationSuccess === "function") {
      const updatedState = await plugin.afterNotificationSuccess({
        previousState,
        previousRecord,
        currentState,
        currentFingerprint,
        previousFingerprint,
        changed,
        config,
        deps,
        notifications
      });

      if (updatedState) {
        await writeJobState(
          stateFilePath,
          stateKey,
          updatedState,
          plugin.getStateFingerprint(updatedState),
          {
            jobName: plugin.name
          }
        );
      }
    }

    logger.info("Notification step completed", {
      jobName: plugin.name,
      notificationCount: notifications.length,
      stateKey,
      stateFilePath
    });

    return {
      jobName: plugin.name,
      skipped: false,
      notified: true,
      changed
    };
  } finally {
    await releaseLock();
    if (ownsLogger) {
      await logger.flush?.();
    }
  }
}

module.exports = {
  createFallbackLogger,
  normalizeNotifications,
  runPluginJob
};
