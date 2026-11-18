"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const { runFanout } = require("../src/jobs/light/fanout");
const { classify, parsePosts, processGav } = require("../src/jobs/light/gav");
const { createPerformance } = require("../src/lib/performance");
const { createDefaultState, renderPoeHtml } = require("../src/jobs/light/mockServer");
const { createMemoryLogger, createSilentLogger, createTempDir, createTextResponse } = require("./helpers");

function channelHtml(posts) {
  return `<html><body>${posts.map(([id, text]) =>
    `<div class="tgme_widget_message" data-post="poltavaOE/${id}"><div class="tgme_widget_message_text">${text}</div><time datetime="2026-11-06T10:00:00+00:00"></time></div>`
  ).join("")}</body></html>`;
}

test("classifies SGAV operational notices without matching general coverage", () => {
  assert.equal(classify("О 17:02 застосовано СГАВ."), "sgav-applied");
  assert.equal(classify("О 19:10 скасовано СГАВ."), "sgav-cancelled");
  assert.equal(classify("СГАВ скасовано!"), "sgav-cancelled");
  assert.equal(classify("СГАВ відмінено!"), "sgav-cancelled");
  assert.equal(classify("Як тільки ситуація стабілізується СГАВ буде скасовано."), null);
  assert.equal(classify("О 17:02 застосовано ГПВ."), null);
  assert.equal(classify("В області застосовано ГАВ!"), "applied");
  assert.equal(classify("ГАВ скасовано!"), "cancelled");
});

test("GAV parser keeps post order and decoded nested text while rejecting other channels", () => {
  const html = `<div class="tgme_widget_message extra" data-post="poltavaOE/102">
    <div class="tgme_widget_message_text">В області <b>застосовано</b> ГАВ!<br>О 13:00 &amp; далі</div>
  </div><div class="tgme_widget_message" data-post="other/103">
    <div class="tgme_widget_message_text">ГАВ скасовано!</div>
  </div><div class="tgme_widget_message" data-post="poltavaOE/104">
    <div class="tgme_widget_message_text"><span>ГАВ</span> скасовано!</div>
  </div><div class="tgme_widget_message" data-post="poltavaOE/invalid">
    <div class="tgme_widget_message_text">ГАВ скасовано!</div>
  </div>`;
  assert.deepEqual(parsePosts(html), [
    { id: 102, text: "В області застосовано ГАВ!\nО 13:00 & далі", type: "applied" },
    { id: 104, text: "ГАВ скасовано!", type: "cancelled" }
  ]);
});

test("GAV parser ignores markup in scripts and keeps nested message text", () => {
  const html = `<script>const decoy = '<div class="tgme_widget_message" data-post="poltavaOE/999">';</script>
    <!-- <div class="tgme_widget_message" data-post="poltavaOE/998"> -->
    <DIV data-post="poltavaOE/106" class="other tgme_widget_message">
      <DIV class="tgme_widget_message_text js-message_text">ГАВ <div><span>скасовано</span></div>&#33;<br/>О 14:00</DIV>
    </DIV>`;
  assert.deepEqual(parsePosts(html), [
    { id: 106, text: "ГАВ скасовано!\nО 14:00", type: "cancelled" }
  ]);
});

test("GAV polling measures headers, body reading, and HTML parsing separately", async () => {
  const dir = await createTempDir();
  const logger = createMemoryLogger();
  const performance = createPerformance("light", logger);
  const sent = await processGav([{ chatId: "a", settings: { gavNotifications: true } }], {
    job: { stateFilePath: path.join(dir, "state.json") },
    telegram: { timeoutMs: 1000, maxRetries: 0, retryBaseDelayMs: 1 }
  }, {
    logger, performance,
    fetchImpl: async () => createTextResponse(200, channelHtml([[100, "Оновлено графік"]]))
  });
  assert.equal(sent, 0);
  assert.deepEqual(logger.entries.filter(entry => entry.meta?.event === "job_phase_performance")
    .map(entry => entry.meta.phase), ["gav_fetch_headers", "gav_read_body", "gav_parse_html"]);
});

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

  posts = [...posts, [105, "О 17:02 застосовано СГАВ."], [106, "О 19:10 скасовано СГАВ."]];
  await run();
  assert.equal(sent.length, 7);
  assert.match(sent[5].text, /^<b>🔴 В області застосовано СГАВ<\/b>\n\nО 17:02 застосовано СГАВ\./);
  assert.match(sent[6].text, /^<b>🟢 СГАВ скасовано<\/b>\n\nО 19:10 скасовано СГАВ\./);
  await run();
  assert.equal(sent.length, 7);
});
