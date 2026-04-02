"use strict";

const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ quiet: true });

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

const ALERT_STATES = new Set(["N", "A", "P"]);

function readRequiredString(key) {
  const value = process.env[key];
  if (!value || !value.trim()) {
    throw new ConfigError(`Missing required environment variable: ${key}`);
  }

  return value.trim();
}

function readOptionalString(key) {
  const value = process.env[key];
  if (!value) {
    return "";
  }

  return value.trim();
}

function readNumber(key, fallback, options = {}) {
  const raw = process.env[key];
  if (raw === undefined || raw === "") {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new ConfigError(`${key} must be a valid number`);
  }

  if (options.integer && !Number.isInteger(value)) {
    throw new ConfigError(`${key} must be an integer`);
  }

  if (options.min !== undefined && value < options.min) {
    throw new ConfigError(`${key} must be >= ${options.min}`);
  }

  if (options.max !== undefined && value > options.max) {
    throw new ConfigError(`${key} must be <= ${options.max}`);
  }

  return value;
}

function readBoolean(key, fallback = false) {
  const raw = process.env[key];
  if (raw === undefined || raw === "") {
    return fallback;
  }

  const normalized = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }

  throw new ConfigError(`${key} must be a boolean (true/false)`);
}

function readOptionalJsonObject(key) {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(`${key} must be a valid JSON object`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError(`${key} must be a JSON object`);
  }

  return parsed;
}

function readRequiredJsonObject(key) {
  const parsed = readOptionalJsonObject(key);
  if (!parsed) {
    throw new ConfigError(`Missing required environment variable: ${key}`);
  }

  if (Object.keys(parsed).length === 0) {
    throw new ConfigError(`${key} must be a non-empty JSON object`);
  }

  return parsed;
}

function readAlertState(key, fallback) {
  const raw = (process.env[key] || fallback).trim().toUpperCase();
  if (!ALERT_STATES.has(raw)) {
    throw new ConfigError(`${key} must be one of: N, A, P`);
  }

  return raw;
}

function readApiHost() {
  const rawHost = (process.env.ALERTS_API_HOST || "https://api.alerts.in.ua").trim();

  let parsed;
  try {
    parsed = new URL(rawHost);
  } catch {
    throw new ConfigError("ALERTS_API_HOST must be a valid URL");
  }

  if (parsed.protocol !== "https:") {
    throw new ConfigError("ALERTS_API_HOST must use https");
  }

  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new ConfigError(
      "ALERTS_API_HOST should contain only scheme + host, e.g. https://api.alerts.in.ua"
    );
  }

  return parsed.origin;
}

function readPathTemplate() {
  const template = (
    process.env.ALERTS_API_PATH_TEMPLATE || "/v1/iot/active_air_raid_alerts/{regionId}.json"
  ).trim();

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

function readActivePathTemplate() {
  const template = (process.env.ALERTS_ACTIVE_API_PATH || "/v1/alerts/active.json").trim();

  if (!template.startsWith("/")) {
    throw new ConfigError("ALERTS_ACTIVE_API_PATH must start with '/'");
  }

  return template;
}

function loadConfig() {
  const useStub = readBoolean("ALERTS_USE_STUB", false);
  const useActiveEndpoint = readBoolean("ALERTS_USE_ACTIVE_ENDPOINT", false);
  const activeMatchCriteria = useActiveEndpoint
    ? readRequiredJsonObject("ALERTS_ACTIVE_MATCH_CRITERIA")
    : readOptionalJsonObject("ALERTS_ACTIVE_MATCH_CRITERIA");

  return {
    api: {
      host: readApiHost(),
      pathTemplate: useActiveEndpoint ? readActivePathTemplate() : readPathTemplate(),
      regionId: readNumber("REGION_ID", 19, { integer: true, min: 1 }),
      useActiveEndpoint,
      activeMatchCriteria,
      token: useStub ? readOptionalString("ALERTS_API_TOKEN") : readRequiredString("ALERTS_API_TOKEN"),
      timeoutMs: readNumber("HTTP_TIMEOUT_MS", 10000, { integer: true, min: 1000 }),
      maxRetries: readNumber("HTTP_MAX_RETRIES", 2, { integer: true, min: 0, max: 10 }),
      retryBaseDelayMs: readNumber("HTTP_RETRY_BASE_DELAY_MS", 500, {
        integer: true,
        min: 100,
        max: 60000
      })
    },
    telegram: {
      botToken: readRequiredString("TG_BOT_TOKEN"),
      chatId: readRequiredString("TG_CHAT_ID"),
      timeoutMs: readNumber("TG_HTTP_TIMEOUT_MS", 10000, { integer: true, min: 1000 }),
      maxRetries: readNumber("TG_HTTP_MAX_RETRIES", 2, { integer: true, min: 0, max: 10 }),
      retryBaseDelayMs: readNumber("TG_HTTP_RETRY_BASE_DELAY_MS", 500, {
        integer: true,
        min: 100,
        max: 60000
      })
    },
    job: {
      lockFilePath: path.resolve(process.cwd(), process.env.LOCK_FILE_PATH || ".alerts-job.lock"),
      stateFilePath: path.resolve(process.cwd(), process.env.STATE_FILE_PATH || ".alerts-last-state.json"),
      activeStubFilePath: path.resolve(
        process.cwd(),
        readOptionalString("ALERTS_ACTIVE_STUB_FILE") || "response.json"
      ),
      alwaysSendTgMessage: readBoolean("ALWAYS_SEND_TG_MESSAGE", false),
      treatPAsA: readBoolean("TREAT_P_AS_A", false),
      useStub,
      stubResponse: readAlertState("ALERTS_STUB_RESPONSE", "N")
    }
  };
}

module.exports = {
  loadConfig,
  ConfigError
};
