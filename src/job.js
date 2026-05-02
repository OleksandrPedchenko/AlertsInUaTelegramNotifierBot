"use strict";

const { readFile } = require("fs/promises");
const { acquireRunLock } = require("./lock");
const { Notifier } = require("./notifier");
const {
  buildAlertsUrl,
  getWithRetry,
  parseActiveAlertsState,
  HttpRequestError
} = require("./httpClient");
const { readLastState, writeLastState } = require("./stateStore");
const { getRegionNameById } = require("./regionCatalog");
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
    const regionName = getRegionNameById(config.api.regionId);
    const requestUrl = buildAlertsUrl(config.api);
    logger.info("Starting alerts polling job", {
      host: config.api.host,
      regionId: config.api.regionId,
      regionName,
      requestUrl,
      endpointMode: config.api.useActiveEndpoint ? "active-json" : "legacy-char",
      useStub: config.job.useStub
    });

    let response;
    const lastState = await readLastState(config.job.stateFilePath);

    if (config.job.useStub) {
      if (config.api.useActiveEndpoint) {
        let stubResponseBody;
        try {
          stubResponseBody = await readFile(config.job.activeStubFilePath, "utf8");
        } catch (error) {
          throw new HttpRequestError(
            `Failed to read active endpoint stub file: ${config.job.activeStubFilePath}`,
            { cause: error, retriable: false }
          );
        }

        const parsedState = parseActiveAlertsState(
          stubResponseBody,
          config.api.activeMatchCriteria
        );

        response = {
          status: 200,
          alertState: parsedState,
          rawBody: stubResponseBody
        };

        logger.warn("Stub mode enabled. External API request skipped", {
          endpointMode: "active-json",
          activeStubFilePath: config.job.activeStubFilePath
        });
      } else {
        response = {
          status: 200,
          alertState: config.job.stubResponse,
          rawBody: config.job.stubResponse
        };
        logger.warn("Stub mode enabled. External API request skipped", {
          endpointMode: "legacy-char",
          stubResponse: config.job.stubResponse
        });
      }
    } else {
      response = await getWithRetry({
        url: requestUrl,
        token: config.api.token,
        timeoutMs: config.api.timeoutMs,
        maxRetries: config.api.maxRetries,
        retryBaseDelayMs: config.api.retryBaseDelayMs,
        ifModifiedSince: lastState ? lastState.lastModified : null,
        responseHandler: config.api.useActiveEndpoint
          ? (responseText) => parseActiveAlertsState(responseText, config.api.activeMatchCriteria)
          : undefined
      });

      if (response.status === 304) {
        if (!lastState) {
          throw new HttpRequestError(
            "Received 304 Not Modified but previous state cache is unavailable",
            { retriable: false }
          );
        }

        logger.info("Alerts data not modified since last request", {
          regionId: config.api.regionId,
          lastModified: lastState.lastModified
        });

        response.alertState = lastState.alertState;
        response.rawBody = "";
        response.lastModified = response.lastModified || lastState.lastModified;
      }

      response.lastModified = response.lastModified || (lastState ? lastState.lastModified : null);
    }

    const normalizedAlertState =
      config.job.treatPAsA && response.alertState === "P" ? "A" : response.alertState;

    logger.info("Alerts data fetched successfully", {
      status: response.status,
      regionId: config.api.regionId,
      alertState: response.alertState,
      normalizedAlertState,
      treatPAsA: config.job.treatPAsA,
      endpointMode: config.api.useActiveEndpoint ? "active-json" : "legacy-char"
    });

    const normalizedPreviousState =
      lastState && config.job.treatPAsA && lastState.alertState === "P"
        ? "A"
        : lastState?.alertState || null;

    const currentState = {
      regionId: config.api.regionId,
      alertState: normalizedAlertState,
      lastModified: response.lastModified || (lastState ? lastState.lastModified : null)
    };
    const isSameState =
      Boolean(lastState) &&
      lastState.regionId === currentState.regionId &&
      normalizedPreviousState === currentState.alertState;
    const forceNotify = config.job.alwaysSendTgMessage;

    // Always write the state to update lastModified even if alertState is unchanged
    await writeLastState(config.job.stateFilePath, currentState);

    if (isSameState && !forceNotify) {
      logger.info("Alert state unchanged; notification skipped", {
        regionId: currentState.regionId,
        alertState: currentState.alertState,
        stateFilePath: config.job.stateFilePath
      });
      return { skipped: false, notified: false, changed: false };
    }

    if (isSameState && forceNotify) {
      logger.info("Alert state unchanged but forced notification is enabled", {
        regionId: currentState.regionId,
        alertState: currentState.alertState
      });
    }

    logger.info("Sending notification", {
      previousState: lastState ? lastState.alertState : null,
      currentState: currentState.alertState,
      regionId: currentState.regionId,
      regionName,
      forced: forceNotify,
      rawAlertState: response.alertState
    });

    const notifier = new Notifier(config.telegram);
    await notifier.notify({
      regionId: config.api.regionId,
      regionName,
      responseStatus: response.status,
      alertState: currentState.alertState,
      rawAlertState: response.alertState,
      source: config.job.useStub ? "stub" : "api",
      rawBody: response.rawBody
    });

    logger.info("Notification step completed", {
      regionId: config.api.regionId,
      stateFilePath: config.job.stateFilePath
    });

    return { skipped: false, notified: true, changed: !isSameState };
  } finally {
    await releaseLock();
  }
}

module.exports = {
  runJob
};
