"use strict";

const { parseFragment } = require("parse5");
const { requestWithRetry } = require("../../lib/httpClient");
const { readJobState, writeJobState } = require("../../lib/stateStore");
const { sendTelegramMessage } = require("../../lib/telegramNotifier");
const { buildGavNotification } = require("./messageCatalog");

const CHANNEL_URL = "https://t.me/s/poltavaOE";
const ACTIVE_KEY = "light:gav:active-chats";

function classify(text) {
  if (/^СГАВ\s+(?:скасовано|відмінено)(?:!|\.|\s|$)/i.test(text) ||
      /^О\s+\d{1,2}:\d{2}\s+(?:скасовано|відмінено)\s+СГАВ(?:!|\.|\s|$)/i.test(text)) {
    return "sgav-cancelled";
  }
  if (/^О\s+\d{1,2}:\d{2}\s+застосовано\s+СГАВ(?:!|\.|\s|$)/i.test(text) ||
      /^СГАВ\s+застосовано(?:!|\.|\s|$)/i.test(text)) {
    return "sgav-applied";
  }
  if (/^ГАВ\s+скасовано(?:!|\s|$)/i.test(text)) return "cancelled";
  if (/^В області застосовано ГАВ(?:!|\s|$)/i.test(text)) return "applied";
  return null;
}

function parsePosts(html) {
  const classAttribute = /(?:^|\s)class\s*=\s*(["'])(.*?)\1/i;
  const postAttribute = /(?:^|\s)data-post\s*=\s*(["'])(.*?)\1/i;
  const hasClass = (tag, name) => classAttribute.exec(tag)?.[2].split(/\s+/).includes(name);
  const textContent = node => node.nodeName === "#text" ? node.value
    : node.tagName === "br" ? "\n" : (node.childNodes || []).map(textContent).join("");
  const tagPattern = /<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>|<!--[\s\S]*?-->|<div\b[^>]*>/gi;
  const posts = [];
  let current;
  for (const match of html.matchAll(tagPattern)) {
    const tag = match[0];
    if (!/^<div\b/i.test(tag)) continue;
    if (hasClass(tag, "tgme_widget_message")) {
      const id = Number(/^poltavaOE\/(\d+)$/.exec(postAttribute.exec(tag)?.[2])?.[1]);
      current = Number.isSafeInteger(id) && id > 0 ? { id, text: "", type: null } : null;
      if (current) posts.push(current);
    } else if (current && !current.text && hasClass(tag, "tgme_widget_message_text")) {
      const start = match.index + tag.length;
      const divTags = /<\/?div\b[^>]*>/gi;
      divTags.lastIndex = start;
      let depth = 1;
      let end = start;
      for (const div of html.matchAll(divTags)) {
        depth += div[0][1] === "/" ? -1 : 1;
        if (depth === 0) { end = div.index; break; }
      }
      const fragment = parseFragment(html.slice(start, end));
      current.text = textContent(fragment).trim();
      current.type = classify(current.text);
    }
  }
  return posts;
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
      measurePhase: (name, operation) => deps.performance
        ? deps.performance.phase(`gav_${name}`, operation) : operation(),
      logger: deps.logger
    });
    const posts = deps.performance
      ? deps.performance.phaseSync("gav_parse_html", () => parsePosts(response.body))
      : parsePosts(response.body);
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
          deps.performance?.addNotifications(1);
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
