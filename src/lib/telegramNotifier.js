"use strict";

const { requestWithRetry } = require("./httpClient");

class NotificationError extends Error {
  constructor(message, details = {}) {
    super(message, details.cause ? { cause: details.cause } : undefined);
    this.name = "NotificationError";
    this.status = details.status;
    this.body = details.body;
    this.retriable = Boolean(details.retriable);
  }
}

function isRetriableStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

async function sendTelegramPhoto(png, caption, config, options = {}) {
  const body = new FormData();
  body.set("chat_id", config.chatId);
  body.set("caption", caption);
  body.set("parse_mode", config.parseMode || "HTML");
  body.set("show_caption_above_media", "true");
  body.set("photo", new Blob([png], { type: "image/png" }), "schedule.png");

  let response;
  try {
    response = await requestWithRetry({
      method: "POST",
      url: `https://api.telegram.org/bot${config.botToken}/sendPhoto`,
      headers: { Accept: "application/json", "User-Agent": config.userAgent || "alerts-tg-bot/1.0" },
      body,
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
      retryBaseDelayMs: config.retryBaseDelayMs,
      responseType: "json",
      fetchImpl: options.fetchImpl,
      logger: options.logger
    });
  } catch (error) {
    throw new NotificationError(error.message, {
      cause: error, status: error.status, body: error.body, retriable: error.retriable
    });
  }
  if (response.body?.ok !== true) {
    throw new NotificationError("Telegram API returned an unsuccessful response body", {
      status: response.status, body: response.body,
      retriable: isRetriableStatus(response.body?.error_code)
    });
  }
}

async function sendTelegramMessage(text, config, options = {}) {
  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;

  let response;
  try {
    response = await requestWithRetry({
      method: "POST",
      url,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": config.userAgent || "alerts-tg-bot/1.0"
      },
      body: JSON.stringify({
        chat_id: config.chatId,
        text,
        parse_mode: config.parseMode || "HTML",
        disable_web_page_preview: config.disableWebPagePreview !== false
      }),
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
      retryBaseDelayMs: config.retryBaseDelayMs,
      responseType: "json",
      fetchImpl: options.fetchImpl,
      logger: options.logger
    });
  } catch (error) {
    throw new NotificationError(error.message, {
      cause: error,
      status: error.status,
      body: error.body,
      retriable: error.retriable
    });
  }

  if (!response.body || response.body.ok !== true) {
    const errorCode = response.body && response.body.error_code;
    throw new NotificationError("Telegram API returned an unsuccessful response body", {
      status: response.status,
      body: response.body,
      retriable: isRetriableStatus(errorCode)
    });
  }
}

class TelegramNotifier {
  constructor(config, options = {}) {
    this.config = config;
    this.options = options;
  }

  async sendMessage(text) {
    await sendTelegramMessage(text, this.config, this.options);
  }
}

module.exports = {
  NotificationError,
  TelegramNotifier,
  sendTelegramMessage,
  sendTelegramPhoto
};
