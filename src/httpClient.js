"use strict";

const { logger } = require("./logger");

class HttpRequestError extends Error {
  constructor(message, details = {}) {
    super(message, details.cause ? { cause: details.cause } : undefined);
    this.name = "HttpRequestError";
    this.status = details.status;
    this.body = details.body;
    this.retriable = Boolean(details.retriable);
  }
}

const ALERT_STATES = new Set(["N", "A", "P"]);

function buildAlertsUrl({ host, pathTemplate, regionId }) {
  const path = pathTemplate.replace("{regionId}", encodeURIComponent(String(regionId)));
  return new URL(path, host).toString();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function parseAlertState(responseText) {
  const trimmed = String(responseText || "").trim();
  if (!trimmed) {
    return null;
  }

  let candidate = trimmed;
  if (
    (candidate.startsWith("\"") && candidate.endsWith("\"")) ||
    (candidate.startsWith("'") && candidate.endsWith("'"))
  ) {
    candidate = candidate.slice(1, -1).trim();
  }

  const state = candidate.toUpperCase();
  return ALERT_STATES.has(state) ? state : null;
}

function isNetworkError(error) {
  return error instanceof TypeError;
}

async function getWithRetry({ url, token, timeoutMs, maxRetries, retryBaseDelayMs }) {
  const maxAttempts = maxRetries + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      let response;
      try {
        response = await fetch(url, {
          method: "GET",
          headers: {
            Accept: "text/plain, application/json",
            Authorization: `Bearer ${token}`,
            "User-Agent": "alerts-tg-bot/1.0"
          },
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeoutId);
      }

      const responseText = await response.text();

      if (!response.ok) {
        throw new HttpRequestError(`HTTP request failed with status ${response.status}`, {
          status: response.status,
          body: responseText,
          retriable: isRetriableStatus(response.status)
        });
      }

      const alertState = parseAlertState(responseText);
      if (alertState === null) {
        throw new HttpRequestError("Unexpected API response. Expected a single alert state char: N, A, or P", {
          status: response.status,
          body: responseText,
          retriable: false
        });
      }

      return {
        status: response.status,
        alertState,
        rawBody: responseText
      };
    } catch (error) {
      const isTimeout = error && error.name === "AbortError";
      const retriable =
        error instanceof HttpRequestError
          ? error.retriable
          : isTimeout || isNetworkError(error);

      if (attempt < maxAttempts && retriable) {
        const waitMs = retryBaseDelayMs * attempt;
        logger.warn("Request attempt failed; retrying", {
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
        throw new HttpRequestError(`HTTP request timed out after ${timeoutMs}ms`, {
          cause: error,
          retriable: false
        });
      }

      if (error instanceof HttpRequestError) {
        throw error;
      }

      throw new HttpRequestError("Network request failed", {
        cause: error,
        retriable: false
      });
    }
  }

  throw new HttpRequestError("Request failed after all retries", { retriable: false });
}

module.exports = {
  buildAlertsUrl,
  getWithRetry,
  HttpRequestError
};
