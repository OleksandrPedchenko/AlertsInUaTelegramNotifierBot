"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const { createDefaultState, createMockServer } = require("../src/jobs/light/mockServer");
const { runFanout } = require("../src/jobs/light/fanout");
const { lightPlugin } = require("../src/jobs/light/plugin");
const { runPluginJob } = require("../src/lib/runner");
const { readJobState, writeJobState } = require("../src/lib/stateStore");
const { createSilentLogger, createTempDir, createTextResponse } = require("./helpers");

test("today's initial photo is pinned and revisions edit its current snapshot", async () => {
  const dir = await createTempDir();
  const subscriptionsFile = path.join(dir, "subscriptions.json");
  await fs.writeFile(subscriptionsFile, JSON.stringify({ queues: {
    "6.1": { enabled: true, chatIds: ["demo-chat"] }
  } }));
  const state = createDefaultState();
  state.days.today["6.1"] = Array(48).fill(1);
  const server = createMockServer(state);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const env = {
    TG_BOT_TOKEN: "test-token", LIGHT_SUBSCRIPTIONS_FILE: subscriptionsFile,
    LIGHT_POE_URL: `http://127.0.0.1:${server.address().port}/customs/dynamicgpv-info.php`,
    LIGHT_STATE_FILE_PATH: path.join(dir, "state.json"),
    LIGHT_LOCK_FILE_PATH: path.join(dir, "light.lock"),
    LIGHT_CURRENT_MINUTE: "0", LIGHT_SCHEDULE_IMAGE_LAYOUT: "vertical",
    LIGHT_GEMINI_ENABLED: "false"
  };
  const requests = [];
  let nextId = 100;
  let failPin = false;
  const fetchImpl = (url, options) => {
    if (!String(url).includes("api.telegram.org")) return fetch(url, options);
    const method = String(url).split("/").at(-1);
    requests.push({ method, body: options.body });
    if (method === "pinChatMessage" && failPin) {
      failPin = false;
      return Promise.resolve(createTextResponse(403, JSON.stringify({ ok: false, description: "temporarily denied" })));
    }
    const result = method.startsWith("send") ? { message_id: nextId++ } : true;
    return Promise.resolve(createTextResponse(200, JSON.stringify({ ok: true, result })));
  };
  try {
    await runFanout(env, { fetchImpl, logger: createSilentLogger() });
    assert.deepEqual(requests.map(item => item.method), ["sendPhoto", "pinChatMessage", "sendPhoto"]);
    assert.deepEqual(JSON.parse(requests[1].body), {
      chat_id: "demo-chat", message_id: 100, disable_notification: true
    });
    const pinKey = "light:6.1:chat:demo-chat:today-pin";
    const initialPin = (await readJobState(env.LIGHT_STATE_FILE_PATH, pinKey)).state;
    assert.equal(initialPin.messageId, 100);
    assert.equal(initialPin.pinned, true);

    requests.length = 0;
    state.days.today["6.1"].fill(2, 32, 34);
    await fetch(`http://127.0.0.1:${server.address().port}/api/state`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state)
    });
    await runFanout(env, { fetchImpl, logger: createSilentLogger() });
    assert.deepEqual(requests.map(item => item.method), ["sendPhoto", "editMessageMedia"]);
    assert.match(requests[0].body.get("caption"), /Було/);
    const edited = JSON.parse(requests[1].body.get("media"));
    assert.equal(requests[1].body.get("message_id"), "100");
    assert.match(edited.caption, /Актуальний графік на сьогодні/);
    assert.doesNotMatch(edited.caption, /Було|Тепер/);
    assert.ok(requests[1].body.get("schedule"));

    requests.length = 0;
    await runFanout(env, { fetchImpl, logger: createSilentLogger() });
    assert.deepEqual(requests, []);

    requests.length = 0;
    env.LIGHT_CURRENT_MINUTE = "1140";
    state.days.today["6.1"][33] = 1;
    await fetch(`http://127.0.0.1:${server.address().port}/api/state`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state)
    });
    await runFanout(env, { fetchImpl, logger: createSilentLogger() });
    assert.deepEqual(requests.map(item => item.method), ["editMessageMedia"]);

    requests.length = 0;
    const priorPin = (await readJobState(env.LIGHT_STATE_FILE_PATH, pinKey)).state;
    priorPin.date = "2000-01-01";
    await writeJobState(env.LIGHT_STATE_FILE_PATH, pinKey, priorPin, priorPin.fingerprint);
    failPin = true;
    await runFanout(env, { fetchImpl, logger: createSilentLogger() });
    assert.deepEqual(requests.map(item => item.method), ["sendPhoto", "pinChatMessage"]);
    assert.equal((await readJobState(env.LIGHT_STATE_FILE_PATH, pinKey)).state.pinned, false);

    requests.length = 0;
    await runFanout(env, { fetchImpl, logger: createSilentLogger() });
    assert.deepEqual(requests.map(item => item.method), ["pinChatMessage", "unpinChatMessage"]);
    assert.equal(JSON.parse(requests[1].body).message_id, 100);
    assert.equal((await readJobState(env.LIGHT_STATE_FILE_PATH, pinKey)).state.pinned, true);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("single-queue text mode pins today and edits the same post on a revision", async () => {
  const dir = await createTempDir();
  const state = createDefaultState();
  state.days.today["6.1"] = Array(48).fill(1);
  const server = createMockServer(state);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const env = {
    TG_BOT_TOKEN: "test-token", LIGHT_TG_CHAT_ID: "demo-chat", LIGHT_QUEUE: "6", LIGHT_SUB_QUEUE: "1",
    LIGHT_POE_URL: `http://127.0.0.1:${server.address().port}/customs/dynamicgpv-info.php`,
    LIGHT_STATE_FILE_PATH: path.join(dir, "state.json"), LIGHT_LOCK_FILE_PATH: path.join(dir, "light.lock"),
    LIGHT_CURRENT_MINUTE: "0", LIGHT_SCHEDULE_IMAGE_ENABLED: "false", LIGHT_GEMINI_ENABLED: "false"
  };
  const methods = [];
  let nextId = 10;
  const fetchImpl = (url, options) => {
    if (!String(url).includes("api.telegram.org")) return fetch(url, options);
    const method = String(url).split("/").at(-1);
    methods.push({ method, body: JSON.parse(options.body) });
    return Promise.resolve(createTextResponse(200, JSON.stringify({
      ok: true, result: method.startsWith("send") ? { message_id: nextId++ } : true
    })));
  };
  try {
    await runPluginJob(lightPlugin, env, { fetchImpl, logger: createSilentLogger(), cwd: dir });
    assert.deepEqual(methods.map(item => item.method), ["sendMessage", "pinChatMessage", "sendMessage"]);
    assert.equal(methods[1].body.message_id, 10);

    methods.length = 0;
    state.days.today["6.1"].fill(2, 32, 34);
    await fetch(`http://127.0.0.1:${server.address().port}/api/state`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state)
    });
    await runPluginJob(lightPlugin, env, { fetchImpl, logger: createSilentLogger(), cwd: dir });
    assert.deepEqual(methods.map(item => item.method), ["sendMessage", "editMessageText"]);
    assert.equal(methods[1].body.message_id, 10);
    assert.match(methods[1].body.text, /Актуальний графік на сьогодні/);
    assert.doesNotMatch(methods[1].body.text, /Було|Тепер/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
