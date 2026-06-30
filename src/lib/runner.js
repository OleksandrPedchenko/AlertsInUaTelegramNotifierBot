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
    error() {}
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

async function runPluginJob(plugin, env = process.env, options = {}) {
  const readers = createEnvReader(env, { cwd: options.cwd || process.cwd() });
  const config =
    options.config || plugin.loadConfig(env, readers);
  const logger =
    options.logger ||
    createLogger({
      cwd: readers.cwd,
      ...(config.log || {})
    });

  const lockFilePath = plugin.getLockFilePath(config);
  const releaseLock = await acquireRunLock(lockFilePath);
  if (!releaseLock) {
    logger.warn("Another job instance is already running; skipping this run", {
      jobName: plugin.name,
      lockFilePath
    });
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

    const notificationText = plugin.buildNotification({
      previousState,
      previousRecord,
      currentState,
      currentFingerprint,
      previousFingerprint,
      changed,
      config
    });

    if (!notificationText) {
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

    await sendTelegramMessage(notificationText, config.telegram, {
      fetchImpl: options.fetchImpl,
      logger
    });

    logger.info("Notification step completed", {
      jobName: plugin.name,
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
  }
}

module.exports = {
  createFallbackLogger,
  runPluginJob
};
