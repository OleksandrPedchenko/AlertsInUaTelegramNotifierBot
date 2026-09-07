"use strict";

const { readFile } = require("fs/promises");
const { HttpRequestError } = require("../../lib/httpClient");
const { loadAlertsConfig } = require("./config");
const { AlertMessageCatalog } = require("./messageCatalog");
const { getRegionNameById } = require("./regionCatalog");
const {
  ALERT_STATES,
  buildAlertsUrl,
  parseActiveAlerts,
  parseActiveAlertsState,
  parseAlertState
} = require("./api");

function normalizeAlertState(config, alertState) {
  return config.job.treatPAsA && alertState === "P" ? "A" : alertState;
}

function extractLastModified(headers) {
  return headers["last-modified"] ? String(headers["last-modified"]).trim() : null;
}

function toStateRecord(config, response, options = {}) {
  const regionName = getRegionNameById(config.api.regionId);
  const normalizedAlertState = normalizeAlertState(config, response.alertState);

  return {
    regionId: config.api.regionId,
    regionName,
    alertState: normalizedAlertState,
    rawAlertState: response.alertState,
    alertLevel: response.alertLevel || null,
    lastModified: response.lastModified || null,
    responseStatus: response.status,
    source: options.source || "api",
    endpointMode: config.api.useActiveEndpoint ? "active-json" : "legacy-char",
    rawBody: response.rawBody || ""
  };
}

async function readStubResponse(config) {
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

    return {
      status: 200,
      ...parseActiveAlerts(stubResponseBody, config.api.activeMatchCriteria),
      rawBody: stubResponseBody,
      lastModified: null
    };
  }

  return {
    status: 200,
    alertState: config.job.stubResponse,
    rawBody: config.job.stubResponse,
    lastModified: null
  };
}

async function fetchAlertsFromApi(config, deps) {
  const requestUrl = buildAlertsUrl(config.api);
  const headers = {
    Accept: "text/plain, application/json",
    Authorization: `Bearer ${config.api.token}`,
    "User-Agent": "alerts-tg-bot/1.0"
  };

  if (deps.previousState && deps.previousState.lastModified) {
    headers["If-Modified-Since"] = deps.previousState.lastModified;
  }

  const response = await deps.requestWithRetry({
    url: requestUrl,
    headers,
    timeoutMs: config.api.timeoutMs,
    maxRetries: config.api.maxRetries,
    retryBaseDelayMs: config.api.retryBaseDelayMs,
    responseType: "text",
    fetchImpl: deps.fetchImpl,
    logger: deps.logger
  });

  const lastModified = extractLastModified(response.headers) ||
    (deps.previousState ? deps.previousState.lastModified : null);

  if (response.status === 304) {
    if (!deps.previousState) {
      throw new HttpRequestError(
        "Received 304 Not Modified but previous state cache is unavailable",
        { retriable: false }
      );
    }

    deps.logger.info("Alerts data not modified since last request", {
      regionId: config.api.regionId,
      lastModified
    });

    return {
      status: response.status,
      alertState: deps.previousState.rawAlertState || deps.previousState.alertState,
      alertLevel: deps.previousState.alertLevel || null,
      rawBody: "",
      lastModified
    };
  }

  const parsed = config.api.useActiveEndpoint
    ? parseActiveAlerts(response.body, config.api.activeMatchCriteria)
    : { alertState: parseAlertState(response.body), alertLevel: null };
  const alertState = String(parsed.alertState || "").trim().toUpperCase();

  if (!ALERT_STATES.has(alertState)) {
    throw new HttpRequestError("Unexpected API response. Expected a single alert state char: N, A, or P", {
      status: response.status,
      body: response.body,
      retriable: false
    });
  }

  return {
    status: response.status,
    alertState,
    alertLevel: parsed.alertLevel,
    rawBody: response.body,
    lastModified
  };
}

const alertsPlugin = {
  name: "alerts",

  loadConfig: loadAlertsConfig,

  getLockFilePath(config) {
    return config.job.lockFilePath;
  },

  getStateFilePath(config) {
    return config.job.stateFilePath;
  },

  getStateKey(config) {
    return `alerts:region:${config.api.regionId}`;
  },

  async fetchCurrent(config, deps) {
    const regionName = getRegionNameById(config.api.regionId);
    const requestUrl = buildAlertsUrl(config.api);

    deps.logger.info("Starting alerts polling job", {
      host: config.api.host,
      regionId: config.api.regionId,
      regionName,
      requestUrl,
      endpointMode: config.api.useActiveEndpoint ? "active-json" : "legacy-char",
      useStub: config.job.useStub
    });

    const response = config.job.useStub
      ? await readStubResponse(config)
      : await fetchAlertsFromApi(config, deps);

    if (config.job.useStub) {
      deps.logger.warn("Stub mode enabled. External API request skipped", {
        endpointMode: config.api.useActiveEndpoint ? "active-json" : "legacy-char",
        activeStubFilePath: config.api.useActiveEndpoint ? config.job.activeStubFilePath : undefined,
        stubResponse: config.api.useActiveEndpoint ? undefined : config.job.stubResponse
      });
    }

    const currentState = toStateRecord(config, response, {
      source: config.job.useStub ? "stub" : "api"
    });

    deps.logger.info("Alerts data fetched successfully", {
      status: currentState.responseStatus,
      regionId: config.api.regionId,
      alertState: currentState.rawAlertState,
      normalizedAlertState: currentState.alertState,
      treatPAsA: config.job.treatPAsA,
      endpointMode: currentState.endpointMode
    });

    return currentState;
  },

  getStateFingerprint(state) {
    return JSON.stringify({
      regionId: state.regionId,
      alertState: state.alertState,
      alertLevel: state.alertLevel || null
    });
  },

  getPreviousStateFingerprint(state, config) {

    return JSON.stringify({
      regionId: state.regionId,
      alertState: normalizeAlertState(config, state.alertState),
      alertLevel: state.alertLevel || null
    });
  },

  shouldNotify({ changed, config, currentState, previousState }) {
    if (!changed && !config.job.alwaysSendTgMessage) {
      return false;
    }

    if (!changed && config.job.alwaysSendTgMessage) {
      return true;
    }

    return (
      !previousState ||
      normalizeAlertState(config, previousState.alertState) !== currentState.alertState ||
      (previousState.alertLevel || null) !== currentState.alertLevel
    );
  },

  buildNotification({ previousState, currentState, config, changed }) {
    if (!changed && config.job.alwaysSendTgMessage) {
      return new AlertMessageCatalog().getMessageByStatus(currentState.alertState, currentState);
    }

    if (
      previousState &&
      normalizeAlertState(config, previousState.alertState) === currentState.alertState &&
      (previousState.alertLevel || null) === currentState.alertLevel
    ) {
      return null;
    }

    return new AlertMessageCatalog().getMessageByStatus(currentState.alertState, currentState);
  }
};

module.exports = {
  alertsPlugin,
  buildAlertsUrl,
  normalizeAlertState,
  parseActiveAlertsState,
  parseAlertState
};
