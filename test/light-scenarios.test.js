"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const { runScenario, parseClockTime } = require("../src/jobs/light/scenarios");
const scenarioSchedule = require("../src/jobs/light/scenarioSchedule.json");
const { createTempDir, createTextResponse } = require("./helpers");

const baseEnv = {
  TG_BOT_TOKEN: "test-token",
  LIGHT_PIN_TODAY_SCHEDULE: "false", LIGHT_SCHEDULE_IMAGE_ENABLED: "false",
  LIGHT_TG_CHAT_ID: "demo-chat",
  LIGHT_TREAT_YELLOW_AS_GREEN: "false",
  GEMINI_API_KEY: "test-gemini-key"
};

async function execute(caseName, time, overrides = {}) {
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
  const result = await runScenario({ caseName, time, env: { ...baseEnv, ...overrides }, fetchImpl });
  return { result, messages, geminiCalls };
}

test("live scenarios default to green treatment of yellow when enabled", async () => {
  const initial = await execute("initial", "12:00", { LIGHT_TREAT_YELLOW_AS_GREEN: "true" });
  assert.equal(initial.messages.length, 2);
  assert.doesNotMatch(initial.messages[0].text, /🟡/);
  assert.match(initial.messages[0].text, /🟢 16:00–21:00 · світло є/);
  const reminder = await execute("tentative-on", "15:50", { LIGHT_TREAT_YELLOW_AS_GREEN: "true" });
  assert.match(reminder.messages[0].text, /🟢 Світло з’явиться через 10 хв/);
});

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

test("fan-out skips a past-only today revision before Telegram and Gemini", async () => {
  const dir = await createTempDir();
  const subscriptionsFile = path.join(dir, "subscriptions.json");
  await fs.writeFile(subscriptionsFile, JSON.stringify({ queues: {
    "5.1": { enabled: true, chatIds: ["demo-chat"] }
  } }));
  const result = await execute("today-shorter", "19:00", { LIGHT_SUBSCRIPTIONS_FILE: subscriptionsFile });
  assert.equal(result.result.notificationCount, 0);
  assert.equal(result.messages.length, 0);
  assert.equal(result.geminiCalls, 0);
});

test("fan-out Gemini input keeps one prior cell and only relevant change windows", async () => {
  const dir = await createTempDir();
  const subscriptionsFile = path.join(dir, "subscriptions.json");
  await fs.writeFile(subscriptionsFile, JSON.stringify({ queues: {
    "5.1": { enabled: true, chatIds: ["demo-chat"] }
  } }));
  let prompt;
  await runScenario({ caseName: "schedule-change", time: "15:45",
    env: { ...baseEnv, LIGHT_SUBSCRIPTIONS_FILE: subscriptionsFile, LIGHT_TREAT_YELLOW_AS_GREEN: "true" },
    fetchImpl: async (url, options) => {
      if (String(url).includes("generativelanguage.googleapis.com")) {
        prompt = JSON.parse(options.body).contents[0].parts[0].text;
        return createTextResponse(200, JSON.stringify({ candidates: [{ content: { parts: [{
          text: JSON.stringify({ "5.1:today": "🔴 Відключення продовжено до 16:30 (було до 16:00)." })
        }] } }] }));
      }
      if (String(url).includes("api.telegram.org")) {
        return createTextResponse(200, JSON.stringify({ ok: true }));
      }
      return fetch(url, options);
    }
  });
  const [item] = JSON.parse(prompt.split("\n").at(-1));
  assert.equal(item.old[0].startMin, 900);
  assert.deepEqual(item.changes, [{ startMin: 960, endMin: 990, oldState: 1, newState: 2 }]);
});

test("scenario fixture keeps fixed six-hour outage starts and a half-hour return period", () => {
  for (const [day, queues] of Object.entries(scenarioSchedule.days)) {
    for (const [queue, cells] of Object.entries(queues)) {
      const starts = cells.flatMap((state, index) =>
        state === 2 && (index === 0 || cells[index - 1] !== 2) ? [index] : []);
      for (let index = 1; index < starts.length; index += 1) {
        assert.equal((starts[index] - starts[index - 1]) % 12, 0, `${day} ${queue} outage starts`);
      }
      for (const start of starts) {
        assert.equal(start % 2, Number(queue.endsWith(".2")), `${day} ${queue} outage clock offset`);
      }
      for (const start of starts) {
        const end = cells.findIndex((state, index) => index > start && state !== 2);
        if (end < 0) continue;
        assert.equal(cells[end], 3, `${day} ${queue} return period`);
        if (end + 1 < cells.length) {
          assert.equal(cells[end + 1], 1, `${day} ${queue} light after return`);
        }
      }
    }
  }
});

for (const [caseName, time, expected, geminiCalls] of [
  ["initial", "12:00", /З’явився графік на сьогодні/, 0],
  ["schedule-change", "12:00", /Змінився графік відключень/, 1],
  ["today-shorter", "12:00", /Змінився графік відключень/, 1],
  ["tomorrow-appears", "12:00", /З’явився графік на завтра/, 0],
  ["tomorrow-change", "12:00", /завтра/, 1],
  ["double-change", "12:00", /завтра/, 1],
  ["off-reminder", "20:50", /🔴 Відключення через/, 0],
  ["tentative-on", "15:50", /🟡 Світло може з’явитися через/, 0],
  ["midnight-off", "23:50", /Завтра 00:00–01:00/, 0],
  ["midnight-tentative-on", "23:50", /Завтра 00:00–00:30/, 0]
]) {
  test(`live scenario ${caseName} uses mock POE and sends expected Telegram message`, async () => {
    const actual = await execute(caseName, time);
    assert.equal(actual.result.notified, true);
    assert.equal(actual.messages.length, caseName === "initial" ? 2 : 1);
    assert.equal(actual.messages[0].chat_id, "demo-chat");
    assert.match(actual.messages[0].text, expected);
    if (caseName === "initial") {
      assert.ok((actual.messages[0].text.match(/🔴/g) || []).length >= 2);
      assert.match(actual.messages[0].text, /🟡/);
      assert.doesNotMatch(actual.messages[0].text, /Завтра/);
      assert.match(actual.messages[1].text, /З’явився графік на завтра/);
    }
    if (caseName === "tomorrow-appears") {
      assert.doesNotMatch(actual.messages[0].text, /Було|Стало|Що змінилось/);
    }
    if (caseName === "schedule-change") {
      assert.match(actual.messages[0].text, /Було[^]*🔴 15:00–16:00[^]*Тепер[^]*🔴 15:00–16:30[^]*🟡 16:30–17:00/);
    }
    if (caseName === "today-shorter") {
      assert.match(actual.messages[0].text, /Було[^]*🔴 15:00–16:00[^]*Тепер[^]*🔴 15:00–15:30[^]*🟡 15:30–16:00/);
    }
    if (caseName === "tomorrow-change") {
      assert.match(actual.messages[0].text, /Було[^]*🔴 10:00–11:00[^]*Тепер[^]*🔴 10:00–10:30[^]*🟡 10:30–11:00/);
    }
    if (caseName === "double-change") {
      assert.match(actual.messages[0].text, /Було[^]*🔴 10:00–11:00[^]*🔴 16:00–17:30[^]*Тепер[^]*🔴 10:00–10:30[^]*🔴 16:00–18:00[^]*🟡 18:00–18:30/);
    }
    if (caseName === "off-reminder" || caseName === "tentative-on") {
      assert.doesNotMatch(actual.messages[0].text, /🔴 17:00–18:00/);
    }
    assert.equal(actual.geminiCalls, geminiCalls);
  });
}

test("schedule change and imminent fixed-start outage send two separate messages", async () => {
  const actual = await execute("schedule-and-off", "20:50");
  assert.equal(actual.messages.length, 2);
  assert.match(actual.messages[0].text, /Змінився графік на завтра/);
  assert.match(actual.messages[0].text, /Було[^]*🔴 10:00–11:00[^]*Тепер[^]*🔴 10:00–10:30/);
  assert.match(actual.messages[1].text, /🔴 Відключення через/);
  assert.match(actual.messages[1].text, /21:00/);
  assert.equal(actual.geminiCalls, 1);
});

test("live tomorrow publication scenario sends to every subscribed chat", async () => {
  const dir = await createTempDir();
  const subscriptionsFile = path.join(dir, "subscriptions.json");
  await fs.writeFile(subscriptionsFile, JSON.stringify({ queues: {
    "5.1": { enabled: true, chatIds: ["chat-five"] },
    "6.1": { enabled: true, chatIds: ["chat-six"] }
  } }));
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
  assert.match(messages[0].text, /на завтра · черга 5\.1/);
  assert.match(messages[1].text, /на завтра · черга 6\.1/);
  assert.match(messages[0].text, /🔴/);
  assert.match(messages[1].text, /🔴/);
  assert.notEqual(messages[0].text.replace(/черга 5\.1/, "черга"),
    messages[1].text.replace(/черга 6\.1/, "черга"));
  assert.ok(messages.every(message => !/Було|Стало|Що змінилось/.test(message.text)));
  await assert.rejects(runScenario({ caseName: "tomorrow-appears", queue: 5, env: {
    ...baseEnv, LIGHT_SUBSCRIPTIONS_FILE: subscriptionsFile
  }, fetchImpl }), /--queue and --subqueue apply only/);
});

test("live revision scenario batches subscribed queues in one Gemini request", async () => {
  const dir = await createTempDir();
  const subscriptionsFile = path.join(dir, "subscriptions.json");
  await fs.writeFile(subscriptionsFile, JSON.stringify({ queues: {
    "5.1": { enabled: true, chatIds: ["chat-five"] },
    "6.1": { enabled: true, chatIds: ["chat-six"] }
  } }));
  const messages = [];
  let poeGets = 0;
  let geminiCalls = 0;
  let geminiPrompt = "";
  const fetchImpl = (url, options) => {
    if (String(url).includes("api.telegram.org")) {
      messages.push(JSON.parse(options.body));
      return Promise.resolve(createTextResponse(200, JSON.stringify({ ok: true })));
    }
    if (String(url).includes("generativelanguage.googleapis.com")) {
      geminiCalls += 1;
      geminiPrompt = JSON.parse(options.body).contents[0].parts[0].text;
      return Promise.resolve(createTextResponse(200, JSON.stringify({ candidates: [{ content: { parts: [{
        text: JSON.stringify({ "5.1:tomorrow": "Зміна для 5.1", "6.1:tomorrow": "Зміна для 6.1" })
      }] } }] })));
    }
    poeGets += 1;
    return fetch(url, options);
  };
  const result = await runScenario({ caseName: "tomorrow-change", env: {
    ...baseEnv, LIGHT_SUBSCRIPTIONS_FILE: subscriptionsFile, LIGHT_TREAT_YELLOW_AS_GREEN: "true"
  }, fetchImpl });
  assert.equal(result.notificationCount, 2);
  assert.equal(poeGets, 1);
  assert.equal(geminiCalls, 1);
  assert.match(geminiPrompt, /🟢 Відключення скорочено/);
  assert.doesNotMatch(geminiPrompt, /Світло є з нового часу кінця/);
  assert.doesNotMatch(geminiPrompt, /"state":3/);
  assert.deepEqual(messages.map(message => message.chat_id), ["chat-five", "chat-six"]);
  assert.match(messages[0].text, /Зміна для 5\.1/);
  assert.match(messages[1].text, /Зміна для 6\.1/);
});
