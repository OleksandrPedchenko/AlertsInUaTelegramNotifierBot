"use strict";

const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");
const test = require("node:test");

const { requestWithRetry, HttpRequestError } = require("../src/lib/httpClient");
const { acquireRunLock } = require("../src/lib/lock");
const { runPluginJob } = require("../src/lib/runner");
const { readJobState, writeJobState } = require("../src/lib/stateStore");
const { createSilentLogger, createTempDir, createTextResponse } = require("./helpers");

test("lock acquisition skips overlapping runs and releases lock", async () => {
  const dir = await createTempDir();
  const lockPath = path.join(dir, "job.lock");

  const release = await acquireRunLock(lockPath);
  assert.equal(typeof release, "function");
  assert.equal(await acquireRunLock(lockPath), null);

  await release();

  const secondRelease = await acquireRunLock(lockPath);
  assert.equal(typeof secondRelease, "function");
  await secondRelease();
});

test("state store reads missing and invalid files as empty and writes keyed state", async () => {
  const dir = await createTempDir();
  const statePath = path.join(dir, "state.json");

  assert.equal(await readJobState(statePath, "job:key"), null);

  await fs.writeFile(statePath, "{invalid json", "utf8");
  assert.equal(await readJobState(statePath, "job:key"), null);

  await writeJobState(statePath, "job:key", { value: "A" }, "fingerprint-A");
  const record = await readJobState(statePath, "job:key");

  assert.equal(record.stateKey, "job:key");
  assert.equal(record.fingerprint, "fingerprint-A");
  assert.deepEqual(record.state, { value: "A" });
});

test("runner skips notification when fingerprint is unchanged", async () => {
  const dir = await createTempDir();
  const statePath = path.join(dir, "state.json");
  await writeJobState(statePath, "demo", { value: "same" }, "same");

  let notificationCalls = 0;
  const plugin = {
    name: "demo",
    loadConfig() {
      return {
        lockFilePath: path.join(dir, "demo.lock"),
        stateFilePath: statePath,
        telegram: {
          botToken: "token",
          chatId: "chat",
          timeoutMs: 1000,
          maxRetries: 0,
          retryBaseDelayMs: 1
        }
      };
    },
    getLockFilePath(config) {
      return config.lockFilePath;
    },
    getStateFilePath(config) {
      return config.stateFilePath;
    },
    getStateKey() {
      return "demo";
    },
    async fetchCurrent() {
      return { value: "same" };
    },
    getStateFingerprint(state) {
      return state.value;
    },
    shouldNotify({ changed }) {
      return changed;
    },
    buildNotification() {
      return "changed";
    }
  };

  const result = await runPluginJob(plugin, {}, {
    logger: createSilentLogger(),
    fetchImpl: async () => {
      notificationCalls += 1;
      return createTextResponse(200, JSON.stringify({ ok: true }));
    }
  });

  assert.equal(result.notified, false);
  assert.equal(result.changed, false);
  assert.equal(notificationCalls, 0);
});

test("runner sends notification when fingerprint changes", async () => {
  const dir = await createTempDir();
  const statePath = path.join(dir, "state.json");
  await writeJobState(statePath, "demo", { value: "old" }, "old");

  let notificationBody = null;
  const plugin = {
    name: "demo",
    loadConfig() {
      return {
        lockFilePath: path.join(dir, "demo.lock"),
        stateFilePath: statePath,
        telegram: {
          botToken: "token",
          chatId: "chat",
          timeoutMs: 1000,
          maxRetries: 0,
          retryBaseDelayMs: 1
        }
      };
    },
    getLockFilePath(config) {
      return config.lockFilePath;
    },
    getStateFilePath(config) {
      return config.stateFilePath;
    },
    getStateKey() {
      return "demo";
    },
    async fetchCurrent() {
      return { value: "new" };
    },
    getStateFingerprint(state) {
      return state.value;
    },
    shouldNotify({ changed }) {
      return changed;
    },
    buildNotification() {
      return "changed message";
    }
  };

  const result = await runPluginJob(plugin, {}, {
    logger: createSilentLogger(),
    fetchImpl: async (_url, options) => {
      notificationBody = JSON.parse(options.body);
      return createTextResponse(200, JSON.stringify({ ok: true }));
    }
  });

  assert.equal(result.notified, true);
  assert.equal(result.changed, true);
  assert.equal(notificationBody.chat_id, "chat");
  assert.equal(notificationBody.text, "changed message");
});

test("HTTP retry retries retriable status and returns success", async () => {
  let calls = 0;
  const response = await requestWithRetry({
    url: "https://example.test",
    maxRetries: 1,
    retryBaseDelayMs: 1,
    timeoutMs: 1000,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return createTextResponse(500, "temporary failure");
      }

      return createTextResponse(200, "ok");
    },
    logger: createSilentLogger()
  });

  assert.equal(calls, 2);
  assert.equal(response.body, "ok");
});

test("HTTP retry does not retry non-retriable status", async () => {
  let calls = 0;

  await assert.rejects(
    requestWithRetry({
      url: "https://example.test",
      maxRetries: 2,
      retryBaseDelayMs: 1,
      timeoutMs: 1000,
      fetchImpl: async () => {
        calls += 1;
        return createTextResponse(400, "bad request");
      },
      logger: createSilentLogger()
    }),
    HttpRequestError
  );

  assert.equal(calls, 1);
});
