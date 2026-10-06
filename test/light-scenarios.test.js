"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const { runScenario, parseClockTime } = require("../src/jobs/light/scenarios");
const { createTempDir, createTextResponse } = require("./helpers");

const baseEnv = {
  TG_BOT_TOKEN: "test-token",
  LIGHT_TG_CHAT_ID: "demo-chat",
  GEMINI_API_KEY: "test-gemini-key"
};

async function execute(caseName, time) {
  const messages = [];
  let geminiCalls = 0;
  const fetchImpl = (url, options) => {
    if (String(url).includes("api.telegram.org")) {
      messages.push(JSON.parse(options.body));
      return Promise.resolve(createTextResponse(200, JSON.stringify({ ok: true })));
    }
    if (String(url).includes("generativelanguage.googleapis.com")) {
      geminiCalls += 1;
      return Promise.resolve(createTextResponse(200, JSON.stringify({
        candidates: [{ content: { parts: [{ text: "Змінився графік відключень." }] } }]
      })));
    }
    return fetch(url, options);
  };
  const result = await runScenario({ caseName, time, env: baseEnv, fetchImpl });
  return { result, messages, geminiCalls };
}

test("time override validates HH:MM", () => {
  assert.equal(parseClockTime("16:50"), 1010);
  assert.throws(() => parseClockTime("24:00"), /HH:MM/);
  assert.throws(() => parseClockTime("9:00"), /HH:MM/);
});

test("Gemini cases require an API key before sending", async () => {
  await assert.rejects(
    runScenario({ caseName: "schedule-change", env: { TG_BOT_TOKEN: "test", LIGHT_TG_CHAT_ID: "demo" } }),
    /requires LIGHT_GEMINI_API_KEY or GEMINI_API_KEY/
  );
});

for (const [caseName, time, expected, geminiCalls] of [
  ["initial", "12:00", /Графік світла/, 0],
  ["schedule-change", "12:00", /Змінився графік відключень/, 1],
  ["tomorrow-appears", "12:00", /черга — завтра/, 0],
  ["tomorrow-change", "12:00", /завтра/, 1],
  ["off-reminder", "16:50", /Нагадування про відключення/, 0],
  ["on-reminder", "17:50", /Нагадування про появу світла/, 0],
  ["tentative-on", "17:50", /може зʼявитися/, 0],
  ["midnight-off", "23:50", /Завтра з 00:00/, 0],
  ["midnight-on", "23:50", /Завтра з 00:00/, 0]
]) {
  test(`live scenario ${caseName} uses mock POE and sends expected Telegram message`, async () => {
    const actual = await execute(caseName, time);
    assert.equal(actual.result.notified, true);
    assert.equal(actual.messages.length, 1);
    assert.equal(actual.messages[0].chat_id, "demo-chat");
    assert.match(actual.messages[0].text, expected);
    if (caseName === "tomorrow-appears") {
      assert.doesNotMatch(actual.messages[0].text, /Було|Стало|Що змінилось/);
    }
    assert.equal(actual.geminiCalls, geminiCalls);
  });
}

test("schedule change and imminent outage send two separate messages", async () => {
  const actual = await execute("schedule-and-off", "16:50");
  assert.equal(actual.messages.length, 2);
  assert.match(actual.messages[0].text, /Змінився графік відключень/);
  assert.match(actual.messages[1].text, /Нагадування про відключення/);
  assert.equal(actual.geminiCalls, 1);
});

test("live tomorrow publication scenario sends to every subscribed chat", async () => {
  const dir = await createTempDir();
  const subscriptionsFile = path.join(dir, "subscriptions.json");
  await fs.writeFile(subscriptionsFile, JSON.stringify({ subscriptions: [
    { queue: 5, subQueue: 1, chatId: "chat-five" },
    { queue: 6, subQueue: 1, chatId: "chat-six" }
  ] }));
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
      return Promise.resolve(createTextResponse(200, JSON.stringify({ ok: true })));
    }
    poeGets += 1;
    return fetch(url, options);
  };
  const result = await runScenario({ caseName: "tomorrow-appears", env: {
    ...baseEnv, LIGHT_SUBSCRIPTIONS_FILE: subscriptionsFile
  }, fetchImpl });
  assert.equal(result.notified, true);
  assert.equal(result.notificationCount, 2);
  assert.equal(poeGets, 1);
  assert.equal(geminiCalls, 0);
  assert.deepEqual(messages.map(message => message.chat_id), ["chat-five", "chat-six"]);
  assert.match(messages[0].text, /5\.1 черга — завтра/);
  assert.match(messages[1].text, /6\.1 черга — завтра/);
  assert.ok(messages.every(message => !/Було|Стало|Що змінилось/.test(message.text)));
  await assert.rejects(runScenario({ caseName: "tomorrow-appears", queue: 5, env: {
    ...baseEnv, LIGHT_SUBSCRIPTIONS_FILE: subscriptionsFile
  }, fetchImpl }), /--queue and --subqueue apply only/);
});

test("live revision scenario batches subscribed queues in one Gemini request", async () => {
  const dir = await createTempDir();
  const subscriptionsFile = path.join(dir, "subscriptions.json");
  await fs.writeFile(subscriptionsFile, JSON.stringify({ subscriptions: [
    { queue: 5, subQueue: 1, chatId: "chat-five" },
    { queue: 6, subQueue: 1, chatId: "chat-six" }
  ] }));
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
        text: JSON.stringify({ "5.1:tomorrow": "Зміна для 5.1", "6.1:tomorrow": "Зміна для 6.1" })
      }] } }] })));
    }
    poeGets += 1;
    return fetch(url, options);
  };
  const result = await runScenario({ caseName: "tomorrow-change", env: {
    ...baseEnv, LIGHT_SUBSCRIPTIONS_FILE: subscriptionsFile
  }, fetchImpl });
  assert.equal(result.notificationCount, 2);
  assert.equal(poeGets, 1);
  assert.equal(geminiCalls, 1);
  assert.deepEqual(messages.map(message => message.chat_id), ["chat-five", "chat-six"]);
  assert.match(messages[0].text, /Зміна для 5\.1/);
  assert.match(messages[1].text, /Зміна для 6\.1/);
});
