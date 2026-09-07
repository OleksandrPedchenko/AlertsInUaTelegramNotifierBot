"use strict";

const assert = require("node:assert/strict");
const path = require("path");
const test = require("node:test");

const { createEnvReader } = require("../src/lib/config");
const { runPluginJob } = require("../src/lib/runner");
const { writeJobState } = require("../src/lib/stateStore");
const { alertsPlugin, parseActiveAlertsState, parseAlertState } = require("../src/jobs/alerts/plugin");
const { createSilentLogger, createTempDir, createTextResponse } = require("./helpers");

function buildAlertsConfig(dir, overrides = {}) {
  const env = {
    ALERTS_API_TOKEN: "alerts-token",
    TG_BOT_TOKEN: "tg-token",
    TG_CHAT_ID: "tg-chat",
    LOCK_FILE_PATH: path.join(dir, "alerts.lock"),
    STATE_FILE_PATH: path.join(dir, "alerts-state.json"),
    LOG_FILE_PATH: path.join(dir, "alerts.log"),
    HTTP_RETRY_BASE_DELAY_MS: "100",
    TG_HTTP_RETRY_BASE_DELAY_MS: "100",
    ...overrides
  };

  return alertsPlugin.loadConfig(env, createEnvReader(env, { cwd: dir }));
}

test("legacy alert state parsing preserves N/A/P behavior", () => {
  assert.equal(parseAlertState("N"), "N");
  assert.equal(parseAlertState("\"A\""), "A");
  assert.equal(parseAlertState("'P'"), "P");
  assert.equal(parseAlertState("unknown"), null);
});

test("active endpoint criteria matching maps matching alert to A and missing alert to N", () => {
  const payload = JSON.stringify({
    alerts: [
      {
        alert_type: "air_raid",
        location_oblast: "Полтавська область",
        finished_at: null
      }
    ]
  });

  assert.equal(
    parseActiveAlertsState(payload, {
      alert_type: "air_raid",
      location_oblast: "Полтавська область",
      finished_at: null
    }),
    "A"
  );
  assert.equal(parseActiveAlertsState(payload, { alert_type: "chemical" }), "N");
});

test("TREAT_P_AS_A affects diff and skips notification for legacy previous P state", async () => {
  const dir = await createTempDir();
  const config = buildAlertsConfig(dir, {
    ALERTS_USE_STUB: "true",
    ALERTS_STUB_RESPONSE: "P",
    TREAT_P_AS_A: "true"
  });

  await writeJobState(
    config.job.stateFilePath,
    alertsPlugin.getStateKey(config),
    {
      regionId: config.api.regionId,
      alertState: "P",
      lastModified: null
    },
    null
  );

  let telegramCalls = 0;
  const result = await runPluginJob(alertsPlugin, {}, {
    config,
    logger: createSilentLogger(),
    fetchImpl: async () => {
      telegramCalls += 1;
      return createTextResponse(200, JSON.stringify({ ok: true }));
    }
  });

  assert.equal(result.changed, false);
  assert.equal(result.notified, false);
  assert.equal(telegramCalls, 0);
});

test("ALWAYS_SEND_TG_MESSAGE bypasses unchanged-state skip", async () => {
  const dir = await createTempDir();
  const config = buildAlertsConfig(dir, {
    ALERTS_USE_STUB: "true",
    ALERTS_STUB_RESPONSE: "N",
    ALWAYS_SEND_TG_MESSAGE: "true"
  });

  await writeJobState(
    config.job.stateFilePath,
    alertsPlugin.getStateKey(config),
    {
      regionId: config.api.regionId,
      regionName: "Полтавська область",
      alertState: "N",
      rawAlertState: "N",
      lastModified: null
    },
    JSON.stringify({ regionId: config.api.regionId, alertState: "N" })
  );

  let telegramBody = null;
  const result = await runPluginJob(alertsPlugin, {}, {
    config,
    logger: createSilentLogger(),
    fetchImpl: async (_url, options) => {
      telegramBody = JSON.parse(options.body);
      return createTextResponse(200, JSON.stringify({ ok: true }));
    }
  });

  assert.equal(result.changed, false);
  assert.equal(result.notified, true);
  assert.equal(telegramBody.chat_id, "tg-chat");
  assert.match(telegramBody.text, /Відбій повітряної тривоги/);
});
