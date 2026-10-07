"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");

const { renderScheduleImage } = require("../src/jobs/light/scheduleImage");
const { sendTelegramPhoto } = require("../src/lib/telegramNotifier");
const { runScenario } = require("../src/jobs/light/scenarios");
const { createTempDir } = require("./helpers");

test("schedule image renders old and new outage periods as a readable PNG", async () => {
  const previous = { timePeriods: [
    { status: 1, startMin: 0, endMin: 900 },
    { status: 2, startMin: 900, endMin: 960 },
    { status: 1, startMin: 960, endMin: 1440 }
  ] };
  const current = { timePeriods: [
    { status: 1, startMin: 0, endMin: 900 },
    { status: 2, startMin: 900, endMin: 930 },
    { status: 1, startMin: 930, endMin: 1440 }
  ] };
  const png = await renderScheduleImage({ queue: 5, subQueue: 1, day: "today", previous, current, currentMinute: 720 });
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(png.length > 10000);
});

test("initial light schedule is delivered as one inline photo", async () => {
  const deliveries = [];
  const result = await runScenario({
    caseName: "initial",
    env: {
      TG_BOT_TOKEN: "token", TG_CHAT_ID: "chat", LIGHT_SCHEDULE_IMAGE_ENABLED: "true",
      LIGHT_GEMINI_ENABLED: "false"
    },
    fetchImpl: async (url, options) => {
      if (!String(url).includes("api.telegram.org")) return fetch(url, options);
      deliveries.push({ url: String(url), body: options.body });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
  });
  assert.equal(result.notified, true);
  assert.equal(deliveries.length, 1);
  assert.match(deliveries[0].url, /\/sendPhoto$/);
  assert.match(deliveries[0].body.get("caption"), /Новий графік/);
  assert.equal(deliveries[0].body.get("photo").type, "image/png");
});

test("Telegram photo sender uploads generated PNG and caption together", async () => {
  const png = Buffer.from([137, 80, 78, 71]);
  let sent;
  await sendTelegramPhoto(png, "<b>Змінився графік</b>", {
    botToken: "token", chatId: "chat", timeoutMs: 1000, maxRetries: 0
  }, {
    fetchImpl: async (url, options) => {
      sent = { url, options };
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200, headers: { "Content-Type": "application/json" }
      });
    }
  });
  assert.match(sent.url, /\/sendPhoto$/);
  assert.equal(sent.options.body.get("chat_id"), "chat");
  assert.equal(sent.options.body.get("caption"), "<b>Змінився графік</b>");
  assert.equal(sent.options.body.get("parse_mode"), "HTML");
  assert.equal(sent.options.body.get("photo").type, "image/png");
});

test("fan-out sends one generated schedule photo to each subscribed chat", async () => {
  const dir = await createTempDir();
  const subscriptionsFile = path.join(dir, "subscriptions.json");
  await fs.writeFile(subscriptionsFile, JSON.stringify({ queues: {
    "5.1": { enabled: true, chatIds: ["chat-a", "chat-b"] }
  } }));
  const deliveries = [];
  const result = await runScenario({
    caseName: "initial",
    env: {
      TG_BOT_TOKEN: "token", LIGHT_SUBSCRIPTIONS_FILE: subscriptionsFile,
      LIGHT_SCHEDULE_IMAGE_ENABLED: "true", LIGHT_GEMINI_ENABLED: "false"
    },
    fetchImpl: async (url, options) => {
      if (!String(url).includes("api.telegram.org")) return fetch(url, options);
      deliveries.push({ url: String(url), chat: options.body.get("chat_id") });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
  });
  assert.equal(result.notificationCount, 2);
  assert.deepEqual(deliveries.map(item => item.chat), ["chat-a", "chat-b"]);
  assert.ok(deliveries.every(item => item.url.endsWith("/sendPhoto")));
});

test("schedule revision keeps the Gemini summary in a photo caption", async () => {
  const deliveries = [];
  await runScenario({
    caseName: "today-shorter",
    env: {
      TG_BOT_TOKEN: "token", TG_CHAT_ID: "chat", GEMINI_API_KEY: "gemini-key",
      LIGHT_SCHEDULE_IMAGE_ENABLED: "true"
    },
    fetchImpl: async (url, options) => {
      if (String(url).includes("api.telegram.org")) {
        deliveries.push({ url: String(url), body: options.body });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }
      if (String(url).includes("generativelanguage.googleapis.com")) {
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{
          text: "🟢 Відключення скорочено до 15:30 (було до 16:00)."
        }] } }] }), { status: 200 });
      }
      return fetch(url, options);
    }
  });
  assert.equal(deliveries.length, 1);
  assert.match(deliveries[0].url, /\/sendPhoto$/);
  assert.match(deliveries[0].body.get("caption"), /Відключення скорочено до 15:30/);
  assert.doesNotMatch(deliveries[0].body.get("caption"), /<blockquote/);
});
