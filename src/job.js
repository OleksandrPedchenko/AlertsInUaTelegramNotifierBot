"use strict";

const { acquireRunLock } = require("./lock");
const { Notifier } = require("./notifier");
const { buildAlertsUrl, getWithRetry } = require("./httpClient");
const { readLastState, writeLastState } = require("./stateStore");
const { logger } = require("./logger");

async function runJob(config) {
  const releaseLock = await acquireRunLock(config.job.lockFilePath);
  if (!releaseLock) {
    logger.warn("Another job instance is already running; skipping this run", {
      lockFilePath: config.job.lockFilePath
    });
    return { skipped: true };
  }

  try {
    const requestUrl = buildAlertsUrl(config.api);
    logger.info("Starting alerts polling job", {
      host: config.api.host,
      regionId: config.api.regionId,
      requestUrl,
      useStub: config.job.useStub
    });

    let response;
    if (config.job.useStub) {
      response = {
        status: 200,
        alertState: config.job.stubResponse,
        rawBody: config.job.stubResponse
      };
      logger.warn("Stub mode enabled. External API request skipped", {
        stubResponse: config.job.stubResponse
      });
    } else {
      response = await getWithRetry({
        url: requestUrl,
        token: config.api.token,
        timeoutMs: config.api.timeoutMs,
        maxRetries: config.api.maxRetries,
        retryBaseDelayMs: config.api.retryBaseDelayMs
      });
    }

    logger.info("Alerts data fetched successfully", {
      status: response.status,
      regionId: config.api.regionId,
      alertState: response.alertState
    });

    const currentState = {
      regionId: config.api.regionId,
      alertState: response.alertState
    };
    const lastState = await readLastState(config.job.stateFilePath);

    if (lastState && lastState.regionId === currentState.regionId && lastState.alertState === currentState.alertState) {
      logger.info("Alert state unchanged; notification skipped", {
        regionId: currentState.regionId,
        alertState: currentState.alertState,
        stateFilePath: config.job.stateFilePath
      });
      return { skipped: false, notified: false, changed: false };
    }

    logger.info("Alert state changed; sending notification", {
      previousState: lastState ? lastState.alertState : null,
      currentState: currentState.alertState,
      regionId: currentState.regionId
    });

    const notifier = new Notifier(config.telegram);
    await notifier.notify({
      regionId: config.api.regionId,
      responseStatus: response.status,
      alertState: response.alertState,
      source: config.job.useStub ? "stub" : "api",
      rawBody: response.rawBody
    });
    await writeLastState(config.job.stateFilePath, currentState);

    logger.info("Notification step completed", {
      regionId: config.api.regionId,
      stateFilePath: config.job.stateFilePath
    });

    return { skipped: false, notified: true, changed: true };
  } finally {
    await releaseLock();
  }
}

module.exports = {
  runJob
};
