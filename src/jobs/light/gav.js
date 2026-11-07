"use strict";

const { JSDOM } = require("jsdom");
const { requestWithRetry } = require("../../lib/httpClient");
const { readJobState, writeJobState } = require("../../lib/stateStore");
const { sendTelegramMessage } = require("../../lib/telegramNotifier");
const { buildGavNotification } = require("./messageCatalog");

const CHANNEL_URL = "https://t.me/s/poltavaOE";
const ACTIVE_KEY = "light:gav:active-chats";

function classify(text) {
  if (/^ГАВ\s+скасовано(?:!|\s|$)/i.test(text)) return "cancelled";
  if (/^В області застосовано ГАВ(?:!|\s|$)/i.test(text)) return "applied";
  return null;
}

function parsePosts(html) {
  const document = new JSDOM(html).window.document;
  return [...document.querySelectorAll(".tgme_widget_message[data-post]")].map(post => {
    const id = Number(/^poltavaOE\/(\d+)$/.exec(post.getAttribute("data-post"))?.[1]);
    const content = post.querySelector(".tgme_widget_message_text")?.cloneNode(true);
    if (content) for (const br of content.querySelectorAll("br")) br.replaceWith(document.createTextNode("\n"));
    const text = content?.textContent?.trim() || "";
    return { id, text, type: classify(text) };
  }).filter(post => Number.isSafeInteger(post.id) && post.id > 0);
}

async function fetchPosts(after, config, deps) {
  const found = new Map();
  let before;
  let latestId;
  for (let page = 0; page < 25; page += 1) {
    const response = await requestWithRetry({
      url: `${CHANNEL_URL}${before ? `?before=${before}` : ""}`,
      timeoutMs: config.telegram.timeoutMs,
      maxRetries: config.telegram.maxRetries,
      retryBaseDelayMs: config.telegram.retryBaseDelayMs,
      fetchImpl: deps.fetchImpl,
      logger: deps.logger
    });
    const posts = parsePosts(response.body);
    if (!posts.length) throw new Error("POE Telegram channel returned no readable posts");
    if (latestId === undefined) latestId = Math.max(...posts.map(post => post.id));
    for (const post of posts) if (post.id > after) found.set(post.id, post);
    const oldest = Math.min(...posts.map(post => post.id));
    if (after === null || oldest <= after) {
      return { posts: [...found.values()].sort((a, b) => a.id - b.id), latestId };
    }
    if (before && oldest >= before) throw new Error("POE Telegram channel pagination did not advance");
    before = oldest;
  }
  throw new Error("POE Telegram channel history exceeded 25 pages; checkpoint retained");
}

async function processGav(subscriptions, config, deps) {
  const chats = [...new Set(subscriptions.filter(item => item.settings.gavNotifications).map(item => item.chatId))];
  const previousActive = (await readJobState(config.job.stateFilePath, ACTIVE_KEY))?.state?.chatIds || [];
  if (!chats.length) {
    await writeJobState(config.job.stateFilePath, ACTIVE_KEY, { chatIds: [] }, "v1");
    return 0;
  }

  const cursors = new Map();
  for (const chatId of chats) {
    const record = await readJobState(config.job.stateFilePath, `light:gav:chat:${chatId}`);
    cursors.set(chatId, previousActive.includes(chatId) ? record?.state?.postId ?? null : null);
  }
  const oldestCursor = [...cursors.values()].filter(id => id !== null).reduce((min, id) => Math.min(min, id), Infinity);
  const { posts, latestId } = await fetchPosts(Number.isFinite(oldestCursor) ? oldestCursor : null, config, deps);
  for (const chatId of chats) {
    if (cursors.get(chatId) !== null) continue;
    await writeJobState(config.job.stateFilePath, `light:gav:chat:${chatId}`, { postId: latestId }, String(latestId));
    cursors.set(chatId, latestId);
  }
  await writeJobState(config.job.stateFilePath, ACTIVE_KEY, { chatIds: chats }, "v1");

  const failures = [];
  let sent = 0;
  for (const chatId of chats) {
    for (const post of posts) {
      if (post.id <= cursors.get(chatId)) continue;
      try {
        if (post.type) {
          const waitMs = 1100 - (Date.now() - (deps.lastSentAt?.get(chatId) || 0));
          if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
          await sendTelegramMessage(buildGavNotification(post), { ...config.telegram, chatId }, deps);
          deps.lastSentAt?.set(chatId, Date.now());
          sent += 1;
        }
        await writeJobState(config.job.stateFilePath, `light:gav:chat:${chatId}`, { postId: post.id }, String(post.id));
        cursors.set(chatId, post.id);
      } catch (error) {
        deps.logger.error("GAV notification failed", { jobName: "light", chatId, postId: post.id, error });
        failures.push(chatId);
        break;
      }
    }
  }
  if (failures.length) throw new Error(`GAV notification failed for chats: ${failures.join(", ")}`);
  return sent;
}

module.exports = { classify, parsePosts, processGav };
