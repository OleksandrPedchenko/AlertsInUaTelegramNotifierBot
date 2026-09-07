"use strict";

class HttpRequestError extends Error {
  constructor(message, details = {}) {
    super(message, details.cause ? { cause: details.cause } : undefined);
    this.name = "HttpRequestError";
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

function isNetworkError(error) {
  return error instanceof TypeError;
}

function headersToObject(headers) {
  const result = {};
  if (!headers) {
    return result;
  }

  if (typeof headers.forEach === "function") {
    headers.forEach((value, key) => {
      result[String(key).toLowerCase()] = value;
    });
    return result;
  }

  for (const [key, value] of Object.entries(headers)) {
    result[String(key).toLowerCase()] = value;
  }

  return result;
}

async function parseResponseBody(response, responseType) {
  if (responseType === "json") {
    const text = await response.text();
    if (!text) {
      return null;
    }

    try {
      return JSON.parse(text);
    } catch (error) {
      throw new HttpRequestError("HTTP response body is not valid JSON", {
        status: response.status,
        body: text,
        cause: error,
        retriable: false
      });
    }
  }

  if (responseType === "buffer") {
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  return response.text();
}

async function requestWithRetry({
  method = "GET",
  url,
  headers = {},
  body,
  timeoutMs = 10000,
  maxRetries = 2,
  retryBaseDelayMs = 500,
  responseType = "text",
  fetchImpl = globalThis.fetch,
  logger
}) {
  if (typeof fetchImpl !== "function") {
    throw new HttpRequestError("fetch is not available in this Node.js runtime", {
      retriable: false
    });
  }

  const maxAttempts = maxRetries + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      let response;
      try {
        response = await fetchImpl(url, {
          method,
          headers,
          body,
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeoutId);
      }

      const parsedHeaders = headersToObject(response.headers);
      if (response.status === 304) {
        return {
          status: response.status,
          ok: true,
          headers: parsedHeaders,
          body: null
        };
      }

      const responseBody = await parseResponseBody(response, responseType);

      if (!response.ok) {
        throw new HttpRequestError(`HTTP request failed with status ${response.status}`, {
          status: response.status,
          body: responseBody,
          retriable: isRetriableStatus(response.status)
        });
      }

      return {
        status: response.status,
        ok: true,
        headers: parsedHeaders,
        body: responseBody
      };
    } catch (error) {
      const isTimeout = error && error.name === "AbortError";
      const retriable =
        error instanceof HttpRequestError
          ? error.retriable
          : isTimeout || isNetworkError(error);

      if (attempt < maxAttempts && retriable) {
        const waitMs = retryBaseDelayMs * attempt;
        if (logger) {
          logger.warn("Request attempt failed; retrying", {
            attempt,
            maxAttempts,
            waitMs,
            reason: error.message,
            status: error.status
          });
        }
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
  HttpRequestError,
  requestWithRetry
};
