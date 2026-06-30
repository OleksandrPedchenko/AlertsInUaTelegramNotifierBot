"use strict";

const { mkdtemp } = require("fs/promises");
const os = require("os");
const path = require("path");

function createSilentLogger() {
  return {
    info() {},
    warn() {},
    error() {}
  };
}

function createTextResponse(status, body, headers = {}) {
  const ok = status >= 200 && status <= 299;
  return {
    status,
    ok,
    headers: {
      forEach(callback) {
        for (const [key, value] of Object.entries(headers)) {
          callback(value, key);
        }
      }
    },
    async text() {
      return body;
    },
    async arrayBuffer() {
      return Buffer.from(body);
    }
  };
}

async function createTempDir() {
  return mkdtemp(path.join(os.tmpdir(), "alerts-tg-bot-test-"));
}

module.exports = {
  createSilentLogger,
  createTempDir,
  createTextResponse
};
