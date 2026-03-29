"use strict";

const { acquireRunLock } = require("./lock");
const { Notifier } = require("./notifier");
const { buildAlertsUrl, getWithRetry } = require("./httpClient");
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

    const notifier = new Notifier(config.telegram);
    await notifier.notify({
      regionId: config.api.regionId,
      responseStatus: response.status,
      alertState: response.alertState,
      source: config.job.useStub ? "stub" : "api",
      rawBody: response.rawBody
    });

    logger.info("Notification step completed", {
      regionId: config.api.regionId
    });

    return { skipped: false };
  } finally {
    await releaseLock();
  }
}

module.exports = {
  runJob
};
