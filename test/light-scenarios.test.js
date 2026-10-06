"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { runScenario, parseClockTime } = require("../src/jobs/light/scenarios");
const { createTextResponse } = require("./helpers");

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
