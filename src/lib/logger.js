"use strict";

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("node:crypto");

const DEFAULT_LOG_FILE_PATH = "alerts.log";
const DEFAULT_LOG_RETENTION_DAYS = 7;
const DEFAULT_LOG_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_LOG_MAX_FILES = 7;
const DEFAULT_LOKI_IP = "192.168.0.41";
const DEFAULT_LOKI_PORT = 3100;
const DEFAULT_LOKI_APP_LABEL = "alerts-tg-bot";
const DEFAULT_LOKI_TIMEOUT_MS = 2000;
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

function pruneArchives(logFilePath, retentionDays, maxFiles) {
  if (retentionDays === 0) return;
  const logDirPath = path.dirname(logFilePath);
  const base = path.basename(logFilePath);
  const now = Date.now();
  const archiveName = /^[0-9]{13}-[0-9]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.log$/i;
  const archives = fs.readdirSync(logDirPath)
    .filter(name => name.startsWith(`${base}.`) && archiveName.test(name.slice(base.length + 1)))
    .flatMap(name => {
      const file = path.join(logDirPath, name);
      try {
        const rotatedAt = Number(name.slice(base.length + 1, base.length + 14));
        return [{ file, mtimeMs: fs.statSync(file).mtimeMs, rotatedAt }];
      } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
      }
    })
    .sort((a, b) => (b.rotatedAt || b.mtimeMs) - (a.rotatedAt || a.mtimeMs));

  let kept = 0;
  for (const archive of archives) {
    // An overlapping process can still have an append open on a just-rotated inode.
    if (now - (archive.rotatedAt || archive.mtimeMs) < 60_000) continue;
    if ((retentionDays > 0 && archive.mtimeMs < now - retentionDays * MS_IN_DAY) || kept >= maxFiles) {
      try {
        fs.unlinkSync(archive.file);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    } else {
      kept++;
    }
  }
}

function rotateIfNeeded(logFilePath, maxFileBytes, retentionDays, nextBytes = 0) {
  let stat;
  try {
    stat = fs.statSync(logFilePath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const createdAt = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
  if (stat.size === 0 || (stat.size + nextBytes <= maxFileBytes &&
      (retentionDays === 0 || createdAt >= Date.now() - MS_IN_DAY))) return;

  const archive = `${logFilePath}.${Date.now()}-${process.pid}-${randomUUID()}.log`;
  try {
    fs.renameSync(logFilePath, archive);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function ensureLogFileReady(logFilePath, retentionDays, maxFileBytes, maxFiles) {
  fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
  pruneArchives(logFilePath, retentionDays, maxFiles);
  rotateIfNeeded(logFilePath, maxFileBytes, retentionDays);
}

function normalizeLokiLabelName(name) {
  const normalized = String(name).replace(/[^a-zA-Z0-9_]/g, "_");
  if (/^[a-zA-Z_]/.test(normalized)) {
    return normalized;
  }

  return `_${normalized}`;
}

function normalizeLokiLabels(labels) {
  const normalized = {};

  for (const [key, value] of Object.entries(labels || {})) {
    if (value === undefined || value === null || value === "") {
      continue;
    }

    normalized[normalizeLokiLabelName(key)] = String(value);
  }

  return normalized;
}

function buildLokiUrl(config) {
  const protocol = config.protocol || "http";
  return `${protocol}://${config.ip}:${config.port}/loki/api/v1/push`;
}

function createLokiStreamKey(labels) {
  return JSON.stringify(Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)));
}

function createLokiLabels(config, logEntry) {
  return normalizeLokiLabels({
    app: config.appLabel || DEFAULT_LOKI_APP_LABEL,
    level: logEntry.level,
    job: logEntry.jobName,
    ...(config.labels || {})
  });
}

function createLokiTimestampNs(logEntry) {
  const timestampMs = Date.parse(logEntry.timestamp);
  const safeTimestampMs = Number.isFinite(timestampMs) ? timestampMs : Date.now();
  return (BigInt(safeTimestampMs) * 1000000n).toString();
}

async function pushToLoki(config, entries, options = {}) {
  if (!config || !config.enabled) {
    return;
  }

  if (entries.length === 0) {
    return;
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    process.stderr.write("[logger] Loki logging is enabled but fetch is not available.\n");
    return;
  }

  const streamsByKey = new Map();
  for (const entry of entries) {
    const labels = createLokiLabels(config, entry.logEntry);
    const key = createLokiStreamKey(labels);

    if (!streamsByKey.has(key)) {
      streamsByKey.set(key, {
        stream: labels,
        values: []
      });
    }

    streamsByKey.get(key).values.push([entry.timestampNs, entry.line]);
  }

  const timeoutMs =
    config.timeoutMs === undefined || config.timeoutMs === null
      ? DEFAULT_LOKI_TIMEOUT_MS
      : config.timeoutMs;
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timeoutId = controller && setTimeout(() => controller.abort(), timeoutMs);
  const body = JSON.stringify({
    streams: Array.from(streamsByKey.values())
  });

  try {
    const response = await fetchImpl(buildLokiUrl(config), {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      signal: controller ? controller.signal : undefined,
      body
    });

    if (response && response.ok === false) {
      process.stderr.write(`[logger] Loki push failed with HTTP ${response.status}.\n`);
    }
  } catch (error) {
    process.stderr.write(`[logger] Loki push failed: ${error.message}\n`);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function createLogger(options = {}) {
  const logFilePath = path.resolve(
    options.cwd || process.cwd(),
    options.logFilePath || DEFAULT_LOG_FILE_PATH
  );
  const retentionDays =
    options.retentionDays === undefined ? DEFAULT_LOG_RETENTION_DAYS : options.retentionDays;
  const maxFileBytes = options.maxFileBytes === undefined ? DEFAULT_LOG_MAX_FILE_BYTES : options.maxFileBytes;
  const maxFiles = options.maxFiles === undefined ? DEFAULT_LOG_MAX_FILES : options.maxFiles;
  const consoleWriter = options.consoleWriter || console;
  const loki = options.loki;
  const fetchImpl = options.fetchImpl;
  const lokiEntries = [];

  try {
    ensureLogFileReady(logFilePath, retentionDays, maxFileBytes, maxFiles);
  } catch (error) {
    process.stderr.write(
      `[logger] Failed to initialize log file '${logFilePath}': ${error.message}\n`
    );
  }

  function writeLogLine(line) {
    rotateIfNeeded(logFilePath, maxFileBytes, retentionDays, Buffer.byteLength(line) + 1);
    fs.appendFileSync(logFilePath, `${line}\n`, "utf8");
  }

  function log(level, message, meta) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...normalizeMeta(meta)
    };
    const line = JSON.stringify(logEntry);

    try {
      writeLogLine(line);
    } catch (error) {
      process.stderr.write(
        `[logger] Failed to write log file '${logFilePath}': ${error.message}\n`
      );
    }

    if (loki && loki.enabled) {
      lokiEntries.push({
        line,
        logEntry,
        timestampNs: createLokiTimestampNs(logEntry)
      });
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
    },
    async flush() {
      if (lokiEntries.length === 0) {
        return;
      }

      const entries = lokiEntries.splice(0, lokiEntries.length);
      await pushToLoki(loki, entries, { fetchImpl });
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
    fetchImpl: options.fetchImpl,
    logFilePath: env.LOG_FILE_PATH || DEFAULT_LOG_FILE_PATH,
    retentionDays,
    maxFileBytes: readPositiveIntegerFromEnv(env, "LOG_MAX_FILE_BYTES", DEFAULT_LOG_MAX_FILE_BYTES),
    maxFiles: readPositiveIntegerFromEnv(env, "LOG_MAX_FILES", DEFAULT_LOG_MAX_FILES),
    loki: readLokiConfigFromEnv(env)
  });
}

function readLokiConfigFromEnv(env = process.env) {
  const rawPort = env.LOKI_PORT;
  let port = DEFAULT_LOKI_PORT;

  if (rawPort !== undefined && rawPort !== "") {
    const parsed = Number(rawPort);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
      port = parsed;
    } else {
      process.stderr.write(
        `[logger] Invalid LOKI_PORT='${rawPort}'. Using default ${DEFAULT_LOKI_PORT}.\n`
      );
    }
  }

  return {
    enabled: true,
    protocol: env.LOKI_PROTOCOL || "http",
    ip: env.LOKI_IP || DEFAULT_LOKI_IP,
    port,
    appLabel: env.LOKI_APP_LABEL || DEFAULT_LOKI_APP_LABEL,
    timeoutMs: readPositiveIntegerFromEnv(env, "LOKI_TIMEOUT_MS", DEFAULT_LOKI_TIMEOUT_MS)
  };
}

function readPositiveIntegerFromEnv(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === "") {
    return fallback;
  }

  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }

  process.stderr.write(`[logger] Invalid ${key}='${raw}'. Using default ${fallback}.\n`);
  return fallback;
}

module.exports = {
  createLogger,
  createLoggerFromEnv,
  readLokiConfigFromEnv
};
