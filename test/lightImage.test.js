"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");
const sharp = require("sharp");

const { renderScheduleImage, renderVerticalScheduleImage } = require("../src/jobs/light/scheduleImage");
const { sendTelegramNotification, sendTelegramPhoto } = require("../src/lib/telegramNotifier");
const { runScenario } = require("../src/jobs/light/scenarios");
const { lightPlugin } = require("../src/jobs/light/plugin");
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
  const { width, height } = await sharp(png).metadata();
  assert.equal(width, 1000);
  assert.ok(height < 650, `Revision image should fit a phone preview; got ${height}px`);
  const pixel = async y => [...await sharp(png).extract({ left: 386, top: y, width: 1, height: 1 }).removeAlpha().raw().toBuffer()];
  assert.deepEqual(await pixel(365), [227, 75, 82]); // 15:45 was red before.
  assert.deepEqual(await pixel(403), [45, 189, 104]); // 15:45 is green now.
});

test("schedule image is independent of the time the notification was sent", async () => {
  const current = { timePeriods: [
    { status: 1, startMin: 0, endMin: 900 },
    { status: 2, startMin: 900, endMin: 960 },
    { status: 1, startMin: 960, endMin: 1440 }
  ] };
  const morning = await renderScheduleImage({ queue: 5, subQueue: 1, day: "today", current, currentMinute: 480 });
  const evening = await renderScheduleImage({ queue: 5, subQueue: 1, day: "today", current, currentMinute: 1080 });
  assert.equal(Buffer.compare(morning, evening), 0);
});

test("timeline bars show visible separators at every half-hour", async () => {
  const current = { timePeriods: [{ status: 1, startMin: 0, endMin: 1440 }] };
  const png = await renderScheduleImage({ queue: 5, subQueue: 1, day: "today", current });
  const pixel = async x => [...await sharp(png).extract({ left: x, top: 252, width: 1, height: 1 }).removeAlpha().raw().toBuffer()];
  assert.notDeepEqual(await pixel(164), await pixel(150));
  assert.notDeepEqual(await pixel(267), await pixel(250));
});

test("vertical timelines align half-hour cells and old/new status", async () => {
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
  const png = await renderVerticalScheduleImage({ queue: 5, subQueue: 1, day: "today", previous, current });
  const { width, height } = await sharp(png).metadata();
  assert.equal(width, 1000);
  assert.ok(height > 800 && height < 1100);
  const pixel = async (x, y) => [...await sharp(png).extract({ left: x, top: y, width: 1, height: 1 }).removeAlpha().raw().toBuffer()];
  assert.deepEqual(await pixel(630, 460), [227, 75, 82]);
  assert.deepEqual(await pixel(800, 460), [45, 189, 104]);
  assert.notDeepEqual(await pixel(800, 450), await pixel(800, 460));
  assert.notDeepEqual(await pixel(133, 294), await pixel(133, 320));
  assert.notDeepEqual(await pixel(200, 294), await pixel(200, 320));
});

test("vertical layout can be selected for live schedule posts", async () => {
  const deliveries = [];
  await runScenario({
    caseName: "initial",
    env: {
      TG_BOT_TOKEN: "token", TG_CHAT_ID: "chat", LIGHT_SCHEDULE_IMAGE_LAYOUT: "vertical",
      LIGHT_GEMINI_ENABLED: "false"
    },
    fetchImpl: async (url, options) => {
      if (!String(url).includes("api.telegram.org")) return fetch(url, options);
      deliveries.push({ url: String(url), body: options.body });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
  });
  assert.equal(deliveries.length, 2);
  assert.ok(deliveries.every(item => item.url.endsWith("/sendPhoto")));
  const png = Buffer.from(await deliveries[0].body.get("photo").arrayBuffer());
  assert.ok((await sharp(png).metadata()).height > 800);
  assert.match(deliveries[0].body.get("caption"), /на сьогодні/);
});

test("yellow legend appears only when a yellow period is displayed", async () => {
  const green = { timePeriods: [{ status: 1, startMin: 0, endMin: 1440 }] };
  const yellow = { timePeriods: [
    { status: 1, startMin: 0, endMin: 900 },
    { status: 3, startMin: 900, endMin: 930 },
    { status: 1, startMin: 930, endMin: 1440 }
  ] };
  const greenPng = await renderScheduleImage({ queue: 5, subQueue: 1, day: "today", current: green });
  const yellowPng = await renderScheduleImage({ queue: 5, subQueue: 1, day: "today", current: yellow });
  async function yellowPixels(image) {
    const pixels = await sharp(image).removeAlpha().raw().toBuffer();
    let count = 0;
    for (let index = 0; index < pixels.length; index += 3) {
      if (pixels[index] === 232 && pixels[index + 1] === 185 && pixels[index + 2] === 52) count += 1;
    }
    return count;
  }
  assert.equal(await yellowPixels(greenPng), 0);
  assert.ok(await yellowPixels(yellowPng) > 0);
});

test("initial today and tomorrow schedules are separate photo posts with full captions", async () => {
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
  assert.equal(deliveries.length, 2);
  assert.deepEqual(deliveries.map(item => item.url.split("/").at(-1)), ["sendPhoto", "sendPhoto"]);
  const todayText = deliveries[0].body.get("caption");
  const tomorrowText = deliveries[1].body.get("caption");
  assert.match(todayText, /на сьогодні/);
  assert.doesNotMatch(todayText, /Завтра/);
  assert.match(tomorrowText, /на завтра/);
  assert.doesNotMatch(tomorrowText, /Сьогодні/);
  assert.match(todayText, /15:00–16:00/);
  assert.equal(deliveries[0].body.get("photo").type, "image/png");
  const png = Buffer.from(await deliveries[0].body.get("photo").arrayBuffer());
  const { width, height } = await sharp(png).metadata();
  assert.equal(width, 1000);
  assert.ok(height < 650, `One-day image should remain compact; got ${height}px`);
});

test("first-run state saves today while leaving failed tomorrow pending", async () => {
  const day = { timePeriods: [{ status: 1, startMin: 0, endMin: 1440 }] };
  const currentState = { scheduleDate: "2026-10-07", today: day, tomorrow: day };
  const saved = await lightPlugin.afterNotificationSuccess({
    previousState: null, currentState,
    notifications: [{ type: "schedule-change:today" }], deps: {}
  });
  assert.equal(saved.today.timePeriods.length, 1);
  assert.equal(saved.tomorrow.timePeriods.length, 0);
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
  assert.notEqual(sent.options.body.get("show_caption_above_media"), "true");
  assert.equal(sent.options.body.get("photo").type, "image/png");
});

test("long photo captions fall back to one full text post", async () => {
  let sent;
  const notification = { text: `<b>Графік</b>\n${"🟢 світло є\n".repeat(100)}`, photo: Buffer.from([1]) };
  const count = await sendTelegramNotification(notification, {
    botToken: "token", chatId: "chat", timeoutMs: 1000, maxRetries: 0
  }, {
    fetchImpl: async (url, options) => {
      sent = { url: String(url), body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
  });
  assert.equal(count, 1);
  assert.match(sent.url, /\/sendMessage$/);
  assert.equal(sent.body.text, notification.text);
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
      deliveries.push({ url: String(url), chat: typeof options.body === "string"
        ? JSON.parse(options.body).chat_id : options.body.get("chat_id") });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
  });
  assert.equal(result.notificationCount, 4);
  assert.deepEqual(deliveries.map(item => item.chat), ["chat-a", "chat-a", "chat-b", "chat-b"]);
  assert.deepEqual(deliveries.map(item => item.url.split("/").at(-1)),
    ["sendPhoto", "sendPhoto", "sendPhoto", "sendPhoto"]);
});

test("schedule revision keeps the Gemini summary and full periods in its photo caption", async () => {
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
  assert.match(deliveries[0].body.get("caption"), /<blockquote expandable>/);
  assert.match(deliveries[0].body.get("caption"), /Змінився графік/);
});

test("new tomorrow schedule sends only tomorrow's photo with full text caption", async () => {
  const deliveries = [];
  await runScenario({
    caseName: "tomorrow-appears",
    env: { TG_BOT_TOKEN: "token", TG_CHAT_ID: "chat", LIGHT_SCHEDULE_IMAGE_ENABLED: "true" },
    fetchImpl: async (url, options) => {
      if (!String(url).includes("api.telegram.org")) return fetch(url, options);
      deliveries.push({ url: String(url), body: options.body });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
  });
  assert.deepEqual(deliveries.map(item => item.url.split("/").at(-1)), ["sendPhoto"]);
  const text = deliveries[0].body.get("caption");
  assert.match(text, /З’явився графік на завтра/);
  assert.doesNotMatch(text, /Сьогодні|Було/);
});
