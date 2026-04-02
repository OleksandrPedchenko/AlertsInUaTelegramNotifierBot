"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_LOG_FILE_PATH = "alerts.log";
const DEFAULT_LOG_RETENTION_DAYS = 7;
const MS_IN_DAY = 24 * 60 * 60 * 1000;

function readLogFilePath() {
  const raw = process.env.LOG_FILE_PATH;
  const relativePath = raw && raw.trim() ? raw.trim() : DEFAULT_LOG_FILE_PATH;
  return path.resolve(process.cwd(), relativePath);
}

function readRetentionDays() {
  const raw = process.env.LOG_RETENTION_DAYS;
  if (raw === undefined || raw === "") {
    return DEFAULT_LOG_RETENTION_DAYS;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    process.stderr.write(
      `[logger] Invalid LOG_RETENTION_DAYS='${raw}'. Using default ${DEFAULT_LOG_RETENTION_DAYS}.\n`
    );
    return DEFAULT_LOG_RETENTION_DAYS;
  }

  return value;
}

const logFilePath = readLogFilePath();
const retentionDays = readRetentionDays();

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

function ensureLogFileReady() {
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

function writeLogLine(line) {
  fs.appendFileSync(logFilePath, `${line}\n`, "utf8");
}

try {
  ensureLogFileReady();
} catch (error) {
  process.stderr.write(
    `[logger] Failed to initialize log file '${logFilePath}': ${error.message}\n`
  );
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
    console.error(line);
    return;
  }

  console.log(line);
}

const logger = {
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

module.exports = {
  logger
};
