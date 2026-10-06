"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const { createMockServer, createDefaultState, renderPoeHtml } = require("../src/jobs/light/mockServer");
const { runFanout, loadSubscriptions } = require("../src/jobs/light/fanout");
const { runLightJob } = require("../src/jobs/light/index");
const { loadLightConfig } = require("../src/jobs/light/config");
const { createEnvReader } = require("../src/lib/config");
const { readJobState, writeJobState } = require("../src/lib/stateStore");
const { lightPlugin } = require("../src/jobs/light/plugin");
const { createSilentLogger, createTempDir, createTextResponse } = require("./helpers");

test("fan-out fetches POE once and batches changed queues into one Gemini call", async () => {
  const dir = await createTempDir();
  const subscriptionsFile = path.join(dir, "subscriptions.json");
  await fs.writeFile(subscriptionsFile, JSON.stringify({ queues: {
    "1.1": { enabled: false, chatIds: [] },
    "5.1": { enabled: true, chatIds: ["chat-a"] },
    "2.2": { enabled: true, chatIds: ["chat-b"] },
    "3.1": { enabled: true, chatIds: ["chat-c"] }
  } }));
  const state = createDefaultState();
  state.days.today["5.1"] = Array(48).fill(1);
  state.days.today["2.2"] = Array(48).fill(1);
  state.days.today["3.1"] = Array(48).fill(1);
  const server = createMockServer(state);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = {
    TG_BOT_TOKEN: "test-token", GEMINI_API_KEY: "test-gemini",
    LIGHT_SUBSCRIPTIONS_FILE: subscriptionsFile,
    LIGHT_POE_URL: `${base}/customs/dynamicgpv-info.php`,
    LIGHT_STATE_FILE_PATH: path.join(dir, "state.json"),
    LIGHT_LOCK_FILE_PATH: path.join(dir, "light.lock")
  };
  const messages = [];
  let poeGets = 0;
  let geminiCalls = 0;
  const fetchImpl = (url, options) => {
    if (String(url).includes("api.telegram.org")) {
      messages.push(JSON.parse(options.body));
      return Promise.resolve(createTextResponse(200, JSON.stringify({ ok: true })));
    }
    if (String(url).includes("generativelanguage.googleapis.com")) {
      geminiCalls += 1;
      return Promise.resolve(createTextResponse(200, JSON.stringify({ candidates: [{ content: { parts: [{
        text: JSON.stringify({ "5.1:today": "Зміна для 5.1", "2.2:today": "Зміна для 2.2", "3.1:today": "Зміна для 3.1" })
      }] } }] })));
    }
    poeGets += 1;
    return fetch(url, options);
  };
  try {
    const config = loadLightConfig(env, createEnvReader(env, { cwd: dir }));
    await runLightJob(config, { fetchImpl, logger: createSilentLogger() });
    assert.equal(poeGets, 1);
    assert.equal(geminiCalls, 0);
    assert.deepEqual(messages.map(message => message.chat_id), ["chat-a", "chat-b", "chat-c"]);
    messages.length = 0;

    state.days.today["5.1"].fill(2, 34, 36);
    state.days.today["2.2"].fill(2, 36, 38);
    state.days.today["3.1"].fill(2, 38, 40);
    await fetch(`${base}/api/state`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state) });
    await runFanout(env, { fetchImpl, logger: createSilentLogger() });
    assert.equal(poeGets, 2);
    assert.equal(geminiCalls, 1);
    assert.equal(messages.length, 3);
    assert.match(messages[0].text, /Зміна для 5\.1/);
    assert.match(messages[1].text, /Зміна для 2\.2/);
    assert.match(messages[2].text, /Зміна для 3\.1/);

    messages.length = 0;
    state.days.today["5.1"].fill(2, 32, 34);
    await fetch(`${base}/api/state`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state) });
    await runFanout(env, { fetchImpl, logger: createSilentLogger() });
    assert.equal(poeGets, 3);
    assert.equal(geminiCalls, 1);
    assert.equal(messages.length, 1);
    assert.match(messages[0].text, /Було/);

    messages.length = 0;
    await runFanout(env, { fetchImpl, logger: createSilentLogger() });
    assert.equal(poeGets, 4);
    assert.equal(geminiCalls, 1);
    assert.equal(messages.length, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("tomorrow-only changes get a separate tomorrow message", async () => {
  const dir = await createTempDir();
  const file = path.join(dir, "subscriptions.json");
  await fs.writeFile(file, JSON.stringify({ subscriptions: [{ queue: 1, subQueue: 1, chatId: "chat-a" }] }));
  const state = createDefaultState();
  const server = createMockServer(state);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = {
    TG_BOT_TOKEN: "test-token", GEMINI_API_KEY: "test-gemini", LIGHT_SUBSCRIPTIONS_FILE: file,
    LIGHT_POE_URL: `${base}/customs/dynamicgpv-info.php`,
    LIGHT_STATE_FILE_PATH: path.join(dir, "state.json"),
    LIGHT_LOCK_FILE_PATH: path.join(dir, "light.lock"),
    LIGHT_GEMINI_MIN_INTERVAL_MINUTES: "0",
    LIGHT_TG_HTTP_MAX_RETRIES: "0"
  };
  const messages = [];
  const prompts = [];
  let failTomorrow = false;
  const fetchImpl = (url, options) => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      const prompt = JSON.parse(options.body).contents[0].parts[0].text;
      prompts.push(prompt);
      const summaries = { "1.1:today": "Сьогодні змінилось", "1.1:tomorrow": "Завтра змінилось" };
      return Promise.resolve(createTextResponse(200, JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(summaries) }] } }] })));
    }
    if (String(url).includes("api.telegram.org")) {
      const message = JSON.parse(options.body);
      messages.push(message);
      const failed = failTomorrow && /Завтра змінилось/.test(message.text);
      return Promise.resolve(createTextResponse(failed ? 403 : 200, JSON.stringify({ ok: !failed })));
    }
    return fetch(url, options);
  };
  try {
    await runFanout(env, { fetchImpl, logger: createSilentLogger() });
    messages.length = 0;
    state.days.tomorrow["1.1"].fill(2, 34, 36);
    await fetch(`${base}/api/state`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state) });
    await runFanout(env, { fetchImpl, logger: createSilentLogger() });
    assert.equal(messages.length, 1);
    assert.match(messages[0].text, /Завтра змінилось/);
    assert.match(messages[0].text, /Завтра змінилось[^]*<blockquote expandable>[^]*Було[^]*Стало[^]*<\/blockquote>/);
    assert.doesNotMatch(messages[0].text, /<b>Сьогодні<\/b>/);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /"day":"tomorrow"/);

    messages.length = 0;
    state.days.today["1.1"].fill(2, 36, 38);
    state.days.tomorrow["1.1"].fill(2, 38, 40);
    await fetch(`${base}/api/state`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state) });
    failTomorrow = true;
    await assert.rejects(runFanout(env, { fetchImpl, logger: createSilentLogger() }));
    assert.equal(messages.length, 2);
    assert.match(messages[0].text, /Сьогодні змінилось/);
    assert.match(messages[1].text, /Завтра змінилось/);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /"day":"today"/);
    assert.match(prompts[1], /"day":"tomorrow"/);

    messages.length = 0;
    failTomorrow = false;
    await runFanout(env, { fetchImpl, logger: createSilentLogger() });
    assert.equal(messages.length, 1);
    assert.match(messages[0].text, /Завтра/);
    assert.doesNotMatch(messages[0].text, /Сьогодні змінилось/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("fan-out skips Gemini when tomorrow first appears but uses it for a later revision", async () => {
  const dir = await createTempDir();
  const subscriptionsFile = path.join(dir, "subscriptions.json");
  const stubFile = path.join(dir, "schedule.html");
  await fs.writeFile(subscriptionsFile, JSON.stringify({ subscriptions: [{ queue: 1, subQueue: 1, chatId: "chat-a" }] }));
  const state = createDefaultState();
  await fs.writeFile(stubFile, renderPoeHtml(state));
  const env = {
    TG_BOT_TOKEN: "test-token", GEMINI_API_KEY: "test-gemini",
    LIGHT_SUBSCRIPTIONS_FILE: subscriptionsFile,
    LIGHT_USE_STUB: "true", LIGHT_STUB_FILE: stubFile,
    LIGHT_STATE_FILE_PATH: path.join(dir, "state.json"),
    LIGHT_LOCK_FILE_PATH: path.join(dir, "light.lock"),
    LIGHT_GEMINI_MIN_INTERVAL_MINUTES: "0"
  };
  const messages = [];
  let geminiCalls = 0;
  const fetchImpl = async (url, options) => {
    if (String(url).includes("api.telegram.org")) {
      messages.push(JSON.parse(options.body).text);
      return createTextResponse(200, JSON.stringify({ ok: true }));
    }
    geminiCalls += 1;
    return createTextResponse(200, JSON.stringify({ candidates: [{ content: { parts: [{
      text: JSON.stringify({ "1.1:tomorrow": "Зміна завтра" })
    }] } }] }));
  };
  const config = loadLightConfig(env, createEnvReader(env, { cwd: dir }));
  await runLightJob(config, { fetchImpl, logger: createSilentLogger() });
  const stateKey = "light:1.1:chat:chat-a";
  const previous = (await readJobState(env.LIGHT_STATE_FILE_PATH, stateKey)).state;
  previous.tomorrow = { timePeriods: [], totalTimeOn: 0, totalTimeOff: 0 };
  await writeJobState(env.LIGHT_STATE_FILE_PATH, stateKey, previous,
    lightPlugin.getStateFingerprint(previous));
  messages.length = 0;

  await runLightJob(config, { fetchImpl, logger: createSilentLogger() });
  assert.equal(geminiCalls, 0);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /черга — завтра/);
  assert.doesNotMatch(messages[0], /Було|Стало|Що змінилось/);

  messages.length = 0;
  state.days.tomorrow["1.1"].fill(2, 34, 36);
  await fs.writeFile(stubFile, renderPoeHtml(state));
  await runLightJob(config, { fetchImpl, logger: createSilentLogger() });
  assert.equal(geminiCalls, 1);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Зміна завтра/);
  assert.match(messages[0], /Було[^]*Стало/);
});

test("subscriptions reject duplicate destination and invalid queue", async () => {
  const dir = await createTempDir();
  const file = path.join(dir, "subscriptions.json");
  await fs.writeFile(file, JSON.stringify({ subscriptions: [
    { queue: 1, subQueue: 1, chatId: "a" },
    { queue: 1, subQueue: 1, chatId: "a" }
  ] }));
  await assert.rejects(loadSubscriptions(file), /duplicate/i);
  await fs.writeFile(file, JSON.stringify({ subscriptions: [{ queue: 7, subQueue: 1, chatId: "a" }] }));
  await assert.rejects(loadSubscriptions(file), /queue/i);
});

test("queue-keyed subscriptions validate enabled destinations", async () => {
  const dir = await createTempDir();
  const file = path.join(dir, "subscriptions.json");
  await fs.writeFile(file, JSON.stringify({ queues: {
    "1.1": { enabled: false, chatIds: [] }
  } }));
  await assert.rejects(loadSubscriptions(file), /no enabled destinations/i);
  await fs.writeFile(file, JSON.stringify({ queues: {
    "7.1": { enabled: true, chatIds: ["chat-a"] }
  } }));
  await assert.rejects(loadSubscriptions(file), /queue/i);
  await fs.writeFile(file, JSON.stringify({ queues: {
    "1.1": { enabled: true, chatIds: [] }
  } }));
  await assert.rejects(loadSubscriptions(file), /chatIds/i);
  await fs.writeFile(file, JSON.stringify({ queues: {
    "1.1": { enabled: true, chatIds: ["chat-a", "chat-a"] }
  } }));
  await assert.rejects(loadSubscriptions(file), /duplicate/i);
  await fs.writeFile(file, JSON.stringify({ queues: {
    "1.1": { enabled: false, chatIds: ["saved-for-later"] },
    "5.1": { enabled: true, chatIds: ["chat-a", "chat-b"] }
  } }));
  assert.deepEqual(await loadSubscriptions(file), [
    { queue: 5, subQueue: 1, chatId: "chat-a" },
    { queue: 5, subQueue: 1, chatId: "chat-b" }
  ]);
});

test("a failed group retries without resending successful groups", async () => {
  const dir = await createTempDir();
  const file = path.join(dir, "subscriptions.json");
  await fs.writeFile(file, JSON.stringify({ subscriptions: [
    { queue: 1, subQueue: 1, chatId: "good" },
    { queue: 1, subQueue: 1, chatId: "retry" }
  ] }));
  const server = createMockServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const env = {
    TG_BOT_TOKEN: "test-token", LIGHT_SUBSCRIPTIONS_FILE: file,
    LIGHT_POE_URL: `http://127.0.0.1:${server.address().port}/customs/dynamicgpv-info.php`,
    LIGHT_STATE_FILE_PATH: path.join(dir, "state.json"),
    LIGHT_LOCK_FILE_PATH: path.join(dir, "light.lock"),
    LIGHT_TG_HTTP_MAX_RETRIES: "0"
  };
  const sent = [];
  let fail = true;
  const fetchImpl = (url, options) => {
    if (String(url).includes("api.telegram.org")) {
      const chat = JSON.parse(options.body).chat_id;
      sent.push(chat);
      if (chat === "retry" && fail) return Promise.resolve(createTextResponse(403, JSON.stringify({ ok: false })));
      return Promise.resolve(createTextResponse(200, JSON.stringify({ ok: true })));
    }
    return fetch(url, options);
  };
  try {
    await assert.rejects(runFanout(env, { fetchImpl, logger: createSilentLogger() }), /retry/);
    assert.deepEqual(sent, ["good", "retry"]);
    fail = false;
    sent.length = 0;
    await runFanout(env, { fetchImpl, logger: createSilentLogger() });
    assert.deepEqual(sent, ["retry"]);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("Gemini rate limit uses raw diff and cools down across retry runs", async () => {
  const dir = await createTempDir();
  const file = path.join(dir, "subscriptions.json");
  await fs.writeFile(file, JSON.stringify({ subscriptions: [{ queue: 1, subQueue: 1, chatId: "retry" }] }));
  const state = createDefaultState();
  const server = createMockServer(state);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = {
    TG_BOT_TOKEN: "test-token", GEMINI_API_KEY: "test-gemini", LIGHT_SUBSCRIPTIONS_FILE: file,
    LIGHT_POE_URL: `${base}/customs/dynamicgpv-info.php`,
    LIGHT_STATE_FILE_PATH: path.join(dir, "state.json"),
    LIGHT_LOCK_FILE_PATH: path.join(dir, "light.lock"),
    LIGHT_TG_HTTP_MAX_RETRIES: "0"
  };
  let geminiCalls = 0;
  let failTelegram = false;
  const messages = [];
  const fetchImpl = (url, options) => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      geminiCalls += 1;
      return Promise.resolve(createTextResponse(429, JSON.stringify({ error: "rate limited" })));
    }
    if (String(url).includes("api.telegram.org")) {
      messages.push(JSON.parse(options.body));
      return Promise.resolve(createTextResponse(failTelegram ? 403 : 200,
        JSON.stringify({ ok: !failTelegram })));
    }
    return fetch(url, options);
  };
  try {
    await runFanout(env, { fetchImpl, logger: createSilentLogger() });
    state.days.today["1.1"].fill(2, 34, 36);
    await fetch(`${base}/api/state`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state) });
    failTelegram = true;
    await assert.rejects(runFanout(env, { fetchImpl, logger: createSilentLogger() }));
    assert.equal(geminiCalls, 1);
    failTelegram = false;
    await runFanout(env, { fetchImpl, logger: createSilentLogger() });
    assert.equal(geminiCalls, 1);
    assert.match(messages.at(-1).text, /Було/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("fan-out sends off and on reminders once for their respective chats", async () => {
  const dir = await createTempDir();
  const file = path.join(dir, "subscriptions.json");
  await fs.writeFile(file, JSON.stringify({ subscriptions: [
    { queue: 1, subQueue: 1, chatId: "off-chat" },
    { queue: 2, subQueue: 1, chatId: "on-chat" }
  ] }));
  const state = createDefaultState();
  state.days.today["1.1"] = Array(48).fill(1);
  state.days.today["1.1"].fill(2, 36);
  state.days.today["2.1"] = Array(48).fill(2);
  state.days.today["2.1"].fill(1, 36);
  const server = createMockServer(state);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const env = {
    TG_BOT_TOKEN: "test-token", LIGHT_SUBSCRIPTIONS_FILE: file,
    LIGHT_POE_URL: `http://127.0.0.1:${server.address().port}/customs/dynamicgpv-info.php`,
    LIGHT_STATE_FILE_PATH: path.join(dir, "state.json"),
    LIGHT_LOCK_FILE_PATH: path.join(dir, "light.lock"),
    LIGHT_OUTAGE_REMINDER_BEFORE_MINUTES: "10",
    LIGHT_CURRENT_MINUTE: "1070"
  };
  const messages = [];
  const fetchImpl = (url, options) => {
    if (String(url).includes("api.telegram.org")) {
      messages.push(JSON.parse(options.body));
      return Promise.resolve(createTextResponse(200, JSON.stringify({ ok: true })));
    }
    return fetch(url, options);
  };
  try {
    await runFanout(env, { fetchImpl, logger: createSilentLogger() });
    assert.equal(messages.length, 4);
    assert.match(messages[1].text, /Нагадування про відключення/);
    assert.equal(messages[1].chat_id, "off-chat");
    assert.match(messages[3].text, /Нагадування про появу світла/);
    assert.equal(messages[3].chat_id, "on-chat");
    messages.length = 0;
    await runFanout(env, { fetchImpl, logger: createSilentLogger() });
    assert.equal(messages.length, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
