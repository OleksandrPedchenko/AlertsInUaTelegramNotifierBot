"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const { runFanout } = require("../src/jobs/light/fanout");
const { createDefaultState, renderPoeHtml } = require("../src/jobs/light/mockServer");
const { createSilentLogger, createTempDir, createTextResponse } = require("./helpers");

function channelHtml(posts) {
  return `<html><body>${posts.map(([id, text]) =>
    `<div class="tgme_widget_message" data-post="poltavaOE/${id}"><div class="tgme_widget_message_text">${text}</div><time datetime="2026-11-06T10:00:00+00:00"></time></div>`
  ).join("")}</body></html>`;
}

test("GAV polling baselines new chats, sends new posts once, and retries failed destinations", async () => {
  const dir = await createTempDir();
  const file = path.join(dir, "subscriptions.json");
  const stub = path.join(dir, "poe.html");
  const subscriptions = { queues: {
    "1.1": { enabled: true, chats: [
      { chatId: "a", settings: { gavNotifications: true } },
      { chatId: "b", settings: {} }
    ] },
    "2.1": { enabled: true, chats: [{ chatId: "a", settings: { gavNotifications: true } }] }
  } };
  await fs.writeFile(file, JSON.stringify(subscriptions));
  await fs.writeFile(stub, renderPoeHtml(createDefaultState()));
  const env = {
    TG_BOT_TOKEN: "test-token", LIGHT_SUBSCRIPTIONS_FILE: file,
    LIGHT_USE_STUB: "true", LIGHT_STUB_FILE: stub,
    LIGHT_PIN_TODAY_SCHEDULE: "false", LIGHT_SCHEDULE_IMAGE_ENABLED: "false",
    LIGHT_STATE_FILE_PATH: path.join(dir, "state.json"), LIGHT_LOCK_FILE_PATH: path.join(dir, "lock"),
    LIGHT_TG_HTTP_MAX_RETRIES: "0", LIGHT_CURRENT_MINUTE: "0"
  };
  let posts = [[100, "В області застосовано ГАВ!<br>О 12:11 введено 5 черг."]];
  let failB = false;
  const sent = [];
  let channelGets = 0;
  const fetchImpl = async (url, options) => {
    if (String(url).startsWith("https://t.me/s/poltavaOE")) {
      channelGets += 1;
      const before = new URL(url).searchParams.get("before");
      const page = posts.filter(([id]) => !before || id < Number(before)).slice(-2);
      return createTextResponse(200, channelHtml(page));
    }
    if (String(url).includes("api.telegram.org")) {
      const message = JSON.parse(options.body);
      if (message.text.includes("ГАВ")) {
        sent.push(message);
        if (failB && message.chat_id === "b") return createTextResponse(403, JSON.stringify({ ok: false }));
      }
      return createTextResponse(200, JSON.stringify({ ok: true }));
    }
    throw new Error(`Unexpected request ${url}`);
  };
  const run = () => runFanout(env, { fetchImpl, logger: createSilentLogger() });
  await run();
  assert.equal(channelGets, 1);
  assert.deepEqual(sent, []);

  posts = [...posts, [101, "В області застосовано ГАВ!<br>О 13:00 введено 5 черг."],
    [102, "ГАВ скасовано!<br>О 13:30 скасовано 5 черг ГАВ."]];
  await run();
  assert.deepEqual(sent.map(message => message.chat_id), ["a", "a"]);
  assert.match(sent[0].text, /^<b>🔴 В області застосовано ГАВ<\/b>\n\nО 13:00/);
  assert.match(sent[0].text, /О 13:00 введено 5 черг/);
  assert.match(sent[1].text, /^<b>🟢 ГАВ скасовано<\/b>\n\nО 13:30/);
  await run();
  assert.equal(sent.length, 2);

  subscriptions.queues["1.1"].chats[1].settings.gavNotifications = true;
  await fs.writeFile(file, JSON.stringify(subscriptions));
  await run();
  assert.equal(sent.length, 2, "newly enabled chat starts at the latest post");

  posts = [...posts, [103, "В області застосовано ГАВ!<br>О 14:00 введено 5 черг."]];
  failB = true;
  await assert.rejects(run(), /GAV/);
  assert.deepEqual(sent.slice(2).map(message => message.chat_id), ["a", "b"]);
  failB = false;
  await run();
  assert.deepEqual(sent.slice(4).map(message => message.chat_id), ["b"]);

  subscriptions.queues["1.1"].chats[0].settings.gavNotifications = false;
  subscriptions.queues["1.1"].chats[1].settings.gavNotifications = false;
  subscriptions.queues["2.1"].chats[0].settings.gavNotifications = false;
  await fs.writeFile(file, JSON.stringify(subscriptions));
  const previousGets = channelGets;
  await run();
  assert.equal(channelGets, previousGets);
  posts = [...posts, [104, "ГАВ скасовано!<br>О 15:00 скасовано 5 черг ГАВ."]];
  subscriptions.queues["1.1"].chats[0].settings.gavNotifications = true;
  await fs.writeFile(file, JSON.stringify(subscriptions));
  await run();
  assert.equal(sent.length, 5, "re-enabled chat does not replay posts from the disabled period");
});
