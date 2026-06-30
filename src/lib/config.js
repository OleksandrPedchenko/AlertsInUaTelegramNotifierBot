"use strict";

const path = require("path");

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

function createEnvReader(env = process.env, options = {}) {
  const cwd = options.cwd || process.cwd();

  function readRequiredString(key) {
    const value = env[key];
    if (!value || !String(value).trim()) {
      throw new ConfigError(`Missing required environment variable: ${key}`);
    }

    return String(value).trim();
  }

  function readOptionalString(key, fallback = "") {
    const value = env[key];
    if (value === undefined || value === null || String(value).trim() === "") {
      return fallback;
    }

    return String(value).trim();
  }

  function readNumber(key, fallback, validation = {}) {
    const raw = env[key];
    if (raw === undefined || raw === "") {
      return fallback;
    }

    const value = Number(raw);
    if (!Number.isFinite(value)) {
      throw new ConfigError(`${key} must be a valid number`);
    }

    if (validation.integer && !Number.isInteger(value)) {
      throw new ConfigError(`${key} must be an integer`);
    }

    if (validation.min !== undefined && value < validation.min) {
      throw new ConfigError(`${key} must be >= ${validation.min}`);
    }

    if (validation.max !== undefined && value > validation.max) {
      throw new ConfigError(`${key} must be <= ${validation.max}`);
    }

    return value;
  }

  function readBoolean(key, fallback = false) {
    const raw = env[key];
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
    const raw = env[key];
    if (raw === undefined || String(raw).trim() === "") {
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

  function readResolvedPath(key, fallback) {
    const value = readOptionalString(key, fallback);
    return path.resolve(cwd, value);
  }

  function readUrlOrigin(key, fallback, validation = {}) {
    const rawUrl = readOptionalString(key, fallback);

    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new ConfigError(`${key} must be a valid URL`);
    }

    if (validation.protocol && parsed.protocol !== validation.protocol) {
      throw new ConfigError(`${key} must use ${validation.protocol.replace(":", "")}`);
    }

    if (validation.originOnly && (parsed.pathname !== "/" || parsed.search || parsed.hash)) {
      throw new ConfigError(`${key} should contain only scheme + host`);
    }

    return parsed.origin;
  }

  return {
    env,
    cwd,
    readRequiredString,
    readOptionalString,
    readNumber,
    readBoolean,
    readOptionalJsonObject,
    readRequiredJsonObject,
    readResolvedPath,
    readUrlOrigin
  };
}

module.exports = {
  ConfigError,
  createEnvReader
};
