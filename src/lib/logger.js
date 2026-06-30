"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_LOG_FILE_PATH = "alerts.log";
const DEFAULT_LOG_RETENTION_DAYS = 7;
const MS_IN_DAY = 24 * 60 * 60 * 1000;

function normalizeMeta(meta) {
  if (!meta || typeof meta !== "object") {
    return {};
  }

  const normalized = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value instanceof Error) {
      normalized[key] = {
        name: value.name,
        message: value.message,
        stack: value.stack
      };
      continue;
    }

    normalized[key] = value;
  }

  return normalized;
}

function ensureLogFileReady(logFilePath, retentionDays) {
  const logDirPath = path.dirname(logFilePath);
  fs.mkdirSync(logDirPath, { recursive: true });

  if (!fs.existsSync(logFilePath) || retentionDays === 0) {
    return;
  }

  const cutoffTimestamp = Date.now() - retentionDays * MS_IN_DAY;
  const currentContent = fs.readFileSync(logFilePath, "utf8");
  if (!currentContent) {
    return;
  }

  const lines = currentContent.split("\n");
  const retainedLines = [];

  for (const line of lines) {
    if (!line) {
      continue;
    }

    try {
      const parsed = JSON.parse(line);
      const timestamp = Date.parse(parsed.timestamp);

      if (Number.isFinite(timestamp) && timestamp < cutoffTimestamp) {
        continue;
      }
    } catch {
      // Keep non-JSON lines instead of risking data loss.
    }

    retainedLines.push(line);
  }

  if (retainedLines.length === lines.filter(Boolean).length) {
    return;
  }

  const trimmedContent = retainedLines.length > 0 ? `${retainedLines.join("\n")}\n` : "";
  fs.writeFileSync(logFilePath, trimmedContent, "utf8");
}

function createLogger(options = {}) {
  const logFilePath = path.resolve(
    options.cwd || process.cwd(),
    options.logFilePath || DEFAULT_LOG_FILE_PATH
  );
  const retentionDays =
    options.retentionDays === undefined ? DEFAULT_LOG_RETENTION_DAYS : options.retentionDays;
  const consoleWriter = options.consoleWriter || console;

  try {
    ensureLogFileReady(logFilePath, retentionDays);
  } catch (error) {
    process.stderr.write(
      `[logger] Failed to initialize log file '${logFilePath}': ${error.message}\n`
    );
  }

  function writeLogLine(line) {
    fs.appendFileSync(logFilePath, `${line}\n`, "utf8");
  }

  function log(level, message, meta) {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      ...normalizeMeta(meta)
    });

    try {
      writeLogLine(line);
    } catch (error) {
      process.stderr.write(
        `[logger] Failed to write log file '${logFilePath}': ${error.message}\n`
      );
    }

    if (level === "error") {
      consoleWriter.error(line);
      return;
    }

    consoleWriter.log(line);
  }

  return {
    info(message, meta) {
      log("info", message, meta);
    },
    warn(message, meta) {
      log("warn", message, meta);
    },
    error(message, meta) {
      log("error", message, meta);
    }
  };
}

function createLoggerFromEnv(env = process.env, options = {}) {
  const rawRetentionDays = env.LOG_RETENTION_DAYS;
  let retentionDays = DEFAULT_LOG_RETENTION_DAYS;

  if (rawRetentionDays !== undefined && rawRetentionDays !== "") {
    const parsed = Number(rawRetentionDays);
    if (Number.isInteger(parsed) && parsed >= 0) {
      retentionDays = parsed;
    } else {
      process.stderr.write(
        `[logger] Invalid LOG_RETENTION_DAYS='${rawRetentionDays}'. Using default ${DEFAULT_LOG_RETENTION_DAYS}.\n`
      );
    }
  }

  return createLogger({
    cwd: options.cwd,
    consoleWriter: options.consoleWriter,
    logFilePath: env.LOG_FILE_PATH || DEFAULT_LOG_FILE_PATH,
    retentionDays
  });
}

module.exports = {
  createLogger,
  createLoggerFromEnv
};
