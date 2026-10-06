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

for (const useStub of [false, true]) {
  test(`alert levels persist and notify on level changes (${useStub ? "stub" : "API"})`, async () => {
    const { writeFile } = require("fs/promises");
    const { readJobState } = require("../src/lib/stateStore");
    const dir = await createTempDir();
    const stubPath = path.join(dir, "response.json");
    const config = buildAlertsConfig(dir, {
      ALERTS_USE_ACTIVE_ENDPOINT: "true",
      ALERTS_ACTIVE_MATCH_CRITERIA: JSON.stringify({ location_uid: "106" }),
      ALERTS_USE_STUB: String(useStub),
      ALERTS_ACTIVE_STUB_FILE: stubPath
    });
    let payload;
    let status = 200;
    const messages = [];
    const run = () => runPluginJob(alertsPlugin, {}, {
      config,
      logger: createSilentLogger(),
      fetchImpl: async (_url, options) => {
        if (options.method === "POST") {
          messages.push(JSON.parse(options.body).text);
          return createTextResponse(200, JSON.stringify({ ok: true }));
        }
        return createTextResponse(status, payload, { "last-modified": "Mon, 07 Sep 2026 10:00:00 GMT" });
      }
    });
    for (const [level, label] of [["yellow", "🟡 Жовтий рівень"], ["red", "🔴 Червоний рівень"]]) {
      payload = JSON.stringify({ alerts: [
        { location_uid: "other", alert_level: "yellow" },
        { location_uid: "106", alert_level: level }
      ] });
      await writeFile(stubPath, payload);
      assert.equal((await run()).notified, true);
      assert.ok(messages.at(-1).includes(label));
      const record = await readJobState(config.job.stateFilePath, alertsPlugin.getStateKey(config));
      assert.equal(record.state.alertLevel, level);
      assert.equal((await run()).notified, false);
    }
    if (!useStub) {
      status = 304;
      assert.equal((await run()).changed, false);
      const record = await readJobState(config.job.stateFilePath, alertsPlugin.getStateKey(config));
      assert.equal(record.state.alertLevel, "red");
      status = 200;
    }
    payload = JSON.stringify({ alerts: [] });
    await writeFile(stubPath, payload);
    assert.equal((await run()).notified, true);
    assert.match(messages.at(-1), /Відбій/);
    assert.doesNotMatch(messages.at(-1), /рівень/);
    const record = await readJobState(config.job.stateFilePath, alertsPlugin.getStateKey(config));
    assert.equal(record.state.alertLevel, null);
  });
}

test("missing or unsupported alert levels keep the original message", () => {
  const { parseActiveAlerts } = require("../src/jobs/alerts/api");
  const { AlertMessageCatalog } = require("../src/jobs/alerts/messageCatalog");
  for (const level of [undefined, "unknown"]) {
    const parsed = parseActiveAlerts(JSON.stringify({ alerts: [{ id: 1, alert_level: level }] }), { id: 1 });
    assert.equal(parsed.alertLevel, null);
    assert.doesNotMatch(new AlertMessageCatalog().getMessageByStatus("A", parsed), /рівень/);
  }
});
