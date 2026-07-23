"use strict";

const { ConfigError } = require("../../lib/config");

const DEFAULT_POE_URL = "https://www.poe.pl.ua/customs/dynamicgpv-info.php";
const DEFAULT_POE_POST_URL = "https://www.poe.pl.ua/customs/search-disconnection.php";
const DEFAULT_GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_GEMINI_MODEL = "models/gemini-flash-lite-latest";
const DEFAULT_POST_BODY = Object.freeze({
  varn: 0,
  filial: "8",
  city_name: "с.Зайченці",
  street_name: "вул.Польова (Гагаріна)",
  building_num: "18"
});

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

function readPostBody(readers) {
  const rawJson = readers.readOptionalString("LIGHT_POST_BODY_JSON");
  if (!rawJson) {
    return DEFAULT_POST_BODY;
  }

  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new ConfigError("LIGHT_POST_BODY_JSON must be valid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError("LIGHT_POST_BODY_JSON must be a JSON object");
  }

  return parsed;
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
    maxOutputTokens: readers.readNumber("LIGHT_GEMINI_MAX_OUTPUT_TOKENS", 512, {
      integer: true,
      min: 32,
      max: 4096
    })
  };
}

function loadLightConfig(_env, readers) {
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
      postUrl: readPoeUrl(readers, "LIGHT_POE_POST_URL", DEFAULT_POE_POST_URL),
      postBody: readPostBody(readers),
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
      chatId: readRequiredStringFromKeys(readers, ["LIGHT_TG_CHAT_ID", "TG_CHAT_ID"]),
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
      lockFilePath: readers.readResolvedPath("LIGHT_LOCK_FILE_PATH", ".light-job.lock"),
      stateFilePath: readers.readResolvedPath("LIGHT_STATE_FILE_PATH", ".light-last-state.json"),
      stubFilePath: readers.readResolvedPath("LIGHT_STUB_FILE", "light-example.html"),
      useStub,
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
      retentionDays: readers.readNumber("LOG_RETENTION_DAYS", 7, { integer: true, min: 0 })
    }
  };
}

module.exports = {
  DEFAULT_POE_POST_URL,
  DEFAULT_POE_URL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_POST_BODY,
  loadLightConfig
};
