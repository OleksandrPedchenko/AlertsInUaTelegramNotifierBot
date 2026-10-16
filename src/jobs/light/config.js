"use strict";

const { ConfigError } = require("../../lib/config");

const DEFAULT_POE_URL = "https://www.poe.pl.ua/customs/dynamicgpv-info.php";
const DEFAULT_GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_GEMINI_MODEL = "models/gemini-flash-lite-latest";
const DEFAULT_LOKI_IP = "192.168.0.41";
const DEFAULT_LOKI_PORT = 3100;
const DEFAULT_LOKI_TIMEOUT_MS = 2000;

function readNumberFromKeys(readers, keys, fallback, validation) {
  for (const key of keys) {
    if (readers.env[key] !== undefined && readers.env[key] !== "") {
      return readers.readNumber(key, fallback, validation);
    }
  }

  return fallback;
}

function readOptionalStringFromKeys(readers, keys, fallback = "") {
  for (const key of keys) {
    const value = readers.readOptionalString(key);
    if (value) {
      return value;
    }
  }

  return fallback;
}

function readRequiredStringFromKeys(readers, keys) {
  const value = readOptionalStringFromKeys(readers, keys);
  if (!value) {
    throw new ConfigError(`Missing required environment variable: ${keys.join(" or ")}`);
  }

  return value;
}

function isLocalHttpUrl(parsed) {
  return (
    parsed.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
  );
}

function readPoeUrl(readers, key, fallback) {
  const value = readers.readOptionalString(key, fallback);

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(`${key} must be a valid URL`);
  }

  if (parsed.protocol !== "https:" && !isLocalHttpUrl(parsed)) {
    throw new ConfigError(`${key} must use https, except localhost mock URLs may use http`);
  }

  return parsed.toString();
}

function readGeminiConfig(readers) {
  const apiKey = readOptionalStringFromKeys(readers, ["LIGHT_GEMINI_API_KEY", "GEMINI_API_KEY"]);
  const enabled =
    readers.env.LIGHT_GEMINI_ENABLED === undefined || readers.env.LIGHT_GEMINI_ENABLED === ""
      ? Boolean(apiKey)
      : readers.readBoolean("LIGHT_GEMINI_ENABLED", false);

  if (enabled && !apiKey) {
    throw new ConfigError(
      "Missing required environment variable: LIGHT_GEMINI_API_KEY or GEMINI_API_KEY"
    );
  }

  return {
    enabled,
    apiKey,
    apiBaseUrl: readers.readOptionalString("LIGHT_GEMINI_API_BASE_URL", DEFAULT_GEMINI_API_BASE_URL),
    model: readers.readOptionalString("LIGHT_GEMINI_MODEL", DEFAULT_GEMINI_MODEL),
    timeoutMs: readers.readNumber("LIGHT_GEMINI_TIMEOUT_MS", 10000, {
      integer: true,
      min: 1000
    }),
    maxRetries: readers.readNumber("LIGHT_GEMINI_MAX_RETRIES", 1, {
      integer: true,
      min: 0,
      max: 10
    }),
    retryBaseDelayMs: readers.readNumber("LIGHT_GEMINI_RETRY_BASE_DELAY_MS", 500, {
      integer: true,
      min: 100,
      max: 60000
    }),
    temperature: readers.readNumber("LIGHT_GEMINI_TEMPERATURE", 0.2, {
      min: 0,
      max: 2
    }),
    maxOutputTokens: readers.readNumber("LIGHT_GEMINI_MAX_OUTPUT_TOKENS", 1024, {
      integer: true,
      min: 32,
      max: 4096
    }),
    minIntervalMinutes: readers.readNumber("LIGHT_GEMINI_MIN_INTERVAL_MINUTES", 5, {
      integer: true, min: 0, max: 1440
    }),
    maxDailyRequests: readers.readNumber("LIGHT_GEMINI_MAX_DAILY_REQUESTS", 20, {
      integer: true, min: 0, max: 10000
    })
  };
}

function readLokiConfig(readers) {
  return {
    enabled: true,
    protocol: readers.readOptionalString("LOKI_PROTOCOL", "http"),
    ip: readers.readOptionalString("LOKI_IP", DEFAULT_LOKI_IP),
    port: readers.readNumber("LOKI_PORT", DEFAULT_LOKI_PORT, {
      integer: true,
      min: 1,
      max: 65535
    }),
    appLabel: readers.readOptionalString("LOKI_APP_LABEL", "alerts-tg-bot"),
    timeoutMs: readers.readNumber("LOKI_TIMEOUT_MS", DEFAULT_LOKI_TIMEOUT_MS, {
      integer: true,
      min: 1,
      max: 60000
    })
  };
}

function loadLightConfig(_env, readers) {
  const scheduleImageLayout = readers.readOptionalString("LIGHT_SCHEDULE_IMAGE_LAYOUT", "horizontal");
  if (!["horizontal", "vertical"].includes(scheduleImageLayout)) {
    throw new Error("LIGHT_SCHEDULE_IMAGE_LAYOUT must be horizontal or vertical");
  }
  const subscriptionsFilePath = readers.readOptionalString("LIGHT_SUBSCRIPTIONS_FILE")
    ? readers.readResolvedPath("LIGHT_SUBSCRIPTIONS_FILE") : null;
  const useStub = readers.readBoolean("LIGHT_USE_STUB", false);
  const currentMinute =
    readers.env.LIGHT_CURRENT_MINUTE === undefined || readers.env.LIGHT_CURRENT_MINUTE === ""
      ? null
      : readers.readNumber("LIGHT_CURRENT_MINUTE", null, {
          integer: true,
          min: 0,
          max: 1439
        });
  const queue = readNumberFromKeys(readers, ["LIGHT_QUEUE", "VAR_QUEUE"], 5, {
    integer: true,
    min: 1,
    max: 6
  });
  const subQueue = readNumberFromKeys(readers, ["LIGHT_SUB_QUEUE", "VAR_SUB_QUEUE"], 1, {
    integer: true,
    min: 1,
    max: 2
  });

  return {
    poe: {
      url: readPoeUrl(readers, "LIGHT_POE_URL", DEFAULT_POE_URL),
      queue,
      subQueue,
      timeoutMs: readNumberFromKeys(readers, ["LIGHT_HTTP_TIMEOUT_MS", "HTTP_TIMEOUT_MS"], 10000, {
        integer: true,
        min: 1000
      }),
      maxRetries: readNumberFromKeys(readers, ["LIGHT_HTTP_MAX_RETRIES", "HTTP_MAX_RETRIES"], 2, {
        integer: true,
        min: 0,
        max: 10
      }),
      retryBaseDelayMs: readNumberFromKeys(
        readers,
        ["LIGHT_HTTP_RETRY_BASE_DELAY_MS", "HTTP_RETRY_BASE_DELAY_MS"],
        500,
        {
          integer: true,
          min: 100,
          max: 60000
        }
      )
    },
    telegram: {
      botToken: readers.readRequiredString("TG_BOT_TOKEN"),
      chatId: subscriptionsFilePath ? readOptionalStringFromKeys(readers, ["LIGHT_TG_CHAT_ID", "TG_CHAT_ID"])
        : readRequiredStringFromKeys(readers, ["LIGHT_TG_CHAT_ID", "TG_CHAT_ID"]),
      timeoutMs: readNumberFromKeys(
        readers,
        ["LIGHT_TG_HTTP_TIMEOUT_MS", "TG_HTTP_TIMEOUT_MS"],
        10000,
        {
          integer: true,
          min: 1000
        }
      ),
      maxRetries: readNumberFromKeys(
        readers,
        ["LIGHT_TG_HTTP_MAX_RETRIES", "TG_HTTP_MAX_RETRIES"],
        2,
        {
          integer: true,
          min: 0,
          max: 10
        }
      ),
      retryBaseDelayMs: readNumberFromKeys(
        readers,
        ["LIGHT_TG_HTTP_RETRY_BASE_DELAY_MS", "TG_HTTP_RETRY_BASE_DELAY_MS"],
        500,
        {
          integer: true,
          min: 100,
          max: 60000
        }
      )
    },
    job: {
      subscriptionsFilePath,
      lockFilePath: readers.readResolvedPath("LIGHT_LOCK_FILE_PATH", ".light-job.lock"),
      stateFilePath: readers.readResolvedPath("LIGHT_STATE_FILE_PATH", ".light-last-state.json"),
      stubFilePath: readers.readResolvedPath("LIGHT_STUB_FILE", "light-example.html"),
      useStub,
      treatYellowAsGreen: readers.readBoolean("LIGHT_TREAT_YELLOW_AS_GREEN", true),
      scheduleImageEnabled: readers.readBoolean("LIGHT_SCHEDULE_IMAGE_ENABLED", true),
      pinTodaySchedule: readers.readBoolean("LIGHT_PIN_TODAY_SCHEDULE", true),
      scheduleImageLayout,
      alwaysSendTgMessage: readers.readBoolean("LIGHT_ALWAYS_SEND_TG_MESSAGE", false),
      outageReminderBeforeMinutes: readers.readNumber("LIGHT_OUTAGE_REMINDER_BEFORE_MINUTES", 0, {
        integer: true,
        min: 0,
        max: 1440
      }),
      currentMinute
    },
    gemini: readGeminiConfig(readers),
    log: {
      logFilePath: readers.readOptionalString("LOG_FILE_PATH", "alerts.log"),
      retentionDays: readers.readNumber("LOG_RETENTION_DAYS", 7, { integer: true, min: 0 }),
      loki: readLokiConfig(readers)
    }
  };
}

module.exports = {
  DEFAULT_POE_URL,
  DEFAULT_GEMINI_MODEL,
  loadLightConfig
};
