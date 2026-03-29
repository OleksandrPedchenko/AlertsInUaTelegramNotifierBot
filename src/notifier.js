"use strict";

const { logger } = require("./logger");

class NotificationError extends Error {
  constructor(message, details = {}) {
    super(message, details.cause ? { cause: details.cause } : undefined);
    this.name = "NotificationError";
    this.status = details.status;
    this.body = details.body;
    this.retriable = Boolean(details.retriable);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function parseJson(text) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isNetworkError(error) {
  return error instanceof TypeError;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatStateDescription(state) {
  if (state === "A") {
    return "Air raid alert is active";
  }

  if (state === "N") {
    return "No active air raid alert";
  }

  if (state === "P") {
    return "Partial/unknown alert state";
  }

  return "Unknown alert state";
}

function buildTelegramMessage(payload) {
  const state = payload.alertState || "UNKNOWN";
  const lines = [
    "<b>Alerts Update</b>",
    `State: <b>${escapeHtml(state)}</b>`,
    `Details: ${escapeHtml(formatStateDescription(state))}`,
    `Region ID: ${escapeHtml(payload.regionId)}`,
    `Source: ${escapeHtml(payload.source || "unknown")}`,
    `Time: ${escapeHtml(new Date().toISOString())}`
  ];

  return lines.join("\n");
}

class Notifier {
  constructor(config) {
    this.config = config;
  }

  async notify(payload) {
    const text = buildTelegramMessage(payload);
    await this.sendTelegramMessage(text);
    logger.info("Telegram notification delivered", {
      regionId: payload.regionId,
      alertState: payload.alertState,
      source: payload.source || "unknown"
    });
  }

  async sendTelegramMessage(text) {
    const url = `https://api.telegram.org/bot${this.config.botToken}/sendMessage`;
    const maxAttempts = this.config.maxRetries + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

        let response;
        try {
          response = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              "User-Agent": "alerts-tg-bot/1.0"
            },
            body: JSON.stringify({
              chat_id: this.config.chatId,
              text,
              parse_mode: "HTML",
              disable_web_page_preview: true
            }),
            signal: controller.signal
          });
        } finally {
          clearTimeout(timeoutId);
        }

        const responseText = await response.text();
        const parsedBody = parseJson(responseText);

        if (!response.ok) {
          throw new NotificationError(`Telegram request failed with status ${response.status}`, {
            status: response.status,
            body: parsedBody || responseText,
            retriable: isRetriableStatus(response.status)
          });
        }

        if (!parsedBody || parsedBody.ok !== true) {
          const errorCode = parsedBody && parsedBody.error_code;
          throw new NotificationError("Telegram API returned an unsuccessful response body", {
            status: response.status,
            body: parsedBody || responseText,
            retriable: isRetriableStatus(errorCode)
          });
        }

        return;
      } catch (error) {
        const isTimeout = error && error.name === "AbortError";
        const retriable =
          error instanceof NotificationError
            ? error.retriable
            : isTimeout || isNetworkError(error);

        if (attempt < maxAttempts && retriable) {
          const waitMs = this.config.retryBaseDelayMs * attempt;
          logger.warn("Telegram notify attempt failed; retrying", {
            attempt,
            maxAttempts,
            waitMs,
            reason: error.message,
            status: error.status
          });
          await delay(waitMs);
          continue;
        }

        if (isTimeout) {
          throw new NotificationError(
            `Telegram request timed out after ${this.config.timeoutMs}ms`,
            { cause: error, retriable: false }
          );
        }

        if (error instanceof NotificationError) {
          throw error;
        }

        throw new NotificationError("Telegram notification request failed", {
          cause: error,
          retriable: false
        });
      }
    }

    throw new NotificationError("Telegram notification failed after all retries", {
      retriable: false
    });
  }
}

module.exports = {
  Notifier,
  NotificationError
};
