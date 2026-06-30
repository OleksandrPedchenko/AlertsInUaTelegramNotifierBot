"use strict";

const { ConfigError } = require("../../lib/config");

const ALERT_STATES = new Set(["N", "A", "P"]);

function readAlertState(readers, key, fallback) {
  const raw = readers.readOptionalString(key, fallback).trim().toUpperCase();
  if (!ALERT_STATES.has(raw)) {
    throw new ConfigError(`${key} must be one of: N, A, P`);
  }

  return raw;
}

function readPathTemplate(readers) {
  const template = readers.readOptionalString(
    "ALERTS_API_PATH_TEMPLATE",
    "/v1/iot/active_air_raid_alerts/{regionId}.json"
  );

  if (!template.startsWith("/")) {
    throw new ConfigError("ALERTS_API_PATH_TEMPLATE must start with '/'");
  }

  if (!template.includes("{regionId}")) {
    throw new ConfigError(
      "ALERTS_API_PATH_TEMPLATE must include '{regionId}', for example /v1/iot/active_air_raid_alerts/{regionId}.json"
    );
  }

  return template;
}

function readActivePathTemplate(readers) {
  const template = readers.readOptionalString("ALERTS_ACTIVE_API_PATH", "/v1/alerts/active.json");

  if (!template.startsWith("/")) {
    throw new ConfigError("ALERTS_ACTIVE_API_PATH must start with '/'");
  }

  return template;
}

function loadAlertsConfig(_env, readers) {
  const useStub = readers.readBoolean("ALERTS_USE_STUB", false);
  const useActiveEndpoint = readers.readBoolean("ALERTS_USE_ACTIVE_ENDPOINT", false);
  const activeMatchCriteria = useActiveEndpoint
    ? readers.readRequiredJsonObject("ALERTS_ACTIVE_MATCH_CRITERIA")
    : readers.readOptionalJsonObject("ALERTS_ACTIVE_MATCH_CRITERIA");

  return {
    api: {
      host: readers.readUrlOrigin("ALERTS_API_HOST", "https://api.alerts.in.ua", {
        protocol: "https:",
        originOnly: true
      }),
      pathTemplate: useActiveEndpoint ? readActivePathTemplate(readers) : readPathTemplate(readers),
      regionId: readers.readNumber("REGION_ID", 19, { integer: true, min: 1 }),
      useActiveEndpoint,
      activeMatchCriteria,
      token: useStub
        ? readers.readOptionalString("ALERTS_API_TOKEN")
        : readers.readRequiredString("ALERTS_API_TOKEN"),
      timeoutMs: readers.readNumber("HTTP_TIMEOUT_MS", 10000, { integer: true, min: 1000 }),
      maxRetries: readers.readNumber("HTTP_MAX_RETRIES", 2, { integer: true, min: 0, max: 10 }),
      retryBaseDelayMs: readers.readNumber("HTTP_RETRY_BASE_DELAY_MS", 500, {
        integer: true,
        min: 100,
        max: 60000
      })
    },
    telegram: {
      botToken: readers.readRequiredString("TG_BOT_TOKEN"),
      chatId: readers.readRequiredString("TG_CHAT_ID"),
      timeoutMs: readers.readNumber("TG_HTTP_TIMEOUT_MS", 10000, { integer: true, min: 1000 }),
      maxRetries: readers.readNumber("TG_HTTP_MAX_RETRIES", 2, {
        integer: true,
        min: 0,
        max: 10
      }),
      retryBaseDelayMs: readers.readNumber("TG_HTTP_RETRY_BASE_DELAY_MS", 500, {
        integer: true,
        min: 100,
        max: 60000
      })
    },
    job: {
      lockFilePath: readers.readResolvedPath("LOCK_FILE_PATH", ".alerts-job.lock"),
      stateFilePath: readers.readResolvedPath("STATE_FILE_PATH", ".alerts-last-state.json"),
      activeStubFilePath: readers.readResolvedPath("ALERTS_ACTIVE_STUB_FILE", "response.json"),
      alwaysSendTgMessage: readers.readBoolean("ALWAYS_SEND_TG_MESSAGE", false),
      treatPAsA: readers.readBoolean("TREAT_P_AS_A", false),
      useStub,
      stubResponse: readAlertState(readers, "ALERTS_STUB_RESPONSE", "N")
    },
    log: {
      logFilePath: readers.readOptionalString("LOG_FILE_PATH", "alerts.log"),
      retentionDays: readers.readNumber("LOG_RETENTION_DAYS", 7, { integer: true, min: 0 })
    }
  };
}

module.exports = {
  loadAlertsConfig
};
