"use strict";

const { readFile } = require("node:fs/promises");

const SETTING_FIELDS = Object.freeze({
  changeSummaryProvider: { type: "choice", values: ["local", "gemini"], env: "LIGHT_CHANGE_SUMMARY_PROVIDER" },
  treatYellowAsGreen: { type: "boolean", env: "LIGHT_TREAT_YELLOW_AS_GREEN" },
  scheduleImageEnabled: { type: "boolean", env: "LIGHT_SCHEDULE_IMAGE_ENABLED" },
  pinTodaySchedule: { type: "boolean", env: "LIGHT_PIN_TODAY_SCHEDULE" },
  scheduleImageLayout: { type: "choice", values: ["horizontal", "vertical"], env: "LIGHT_SCHEDULE_IMAGE_LAYOUT" },
  alwaysSendTgMessage: { type: "boolean", env: "LIGHT_ALWAYS_SEND_TG_MESSAGE" },
  outageReminderBeforeMinutes: { type: "integer", min: 0, max: 1440, env: "LIGHT_OUTAGE_REMINDER_BEFORE_MINUTES" }
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateSettings(value, label) {
  if (value === undefined) return {};
  if (!isObject(value)) throw new Error(`${label}: settings must be an object`);
  const settings = {};
  for (const [key, actual] of Object.entries(value)) {
    const field = SETTING_FIELDS[key];
    if (!field) throw new Error(`${label}: unknown setting ${key}`);
    if (field.type === "boolean" && typeof actual !== "boolean") {
      throw new Error(`${label}: ${key} must be a boolean`);
    }
    if (field.type === "choice" && !field.values.includes(actual)) {
      throw new Error(`${label}: ${key} must be ${field.values.join(" or ")}`);
    }
    if (field.type === "integer" && (!Number.isInteger(actual) || actual < field.min || actual > field.max)) {
      throw new Error(`${label}: ${key} must be an integer from ${field.min} to ${field.max}`);
    }
    settings[key] = actual;
  }
  return settings;
}

function collectSubscriptions(data, { requireEnabled = true } = {}) {
  const seen = new Set();
  const all = [];
  function add(queue, subQueue, value, label, enabled = true) {
    if (!Number.isInteger(queue) || queue < 1 || queue > 6) throw new Error(`${label}: queue must be 1..6`);
    if (!Number.isInteger(subQueue) || subQueue < 1 || subQueue > 2) throw new Error(`${label}: subQueue must be 1 or 2`);
    if (!isObject(value)) throw new Error(`${label}: chat must be an object`);
    const chatId = typeof value.chatId === "string" ? value.chatId.trim() : "";
    if (!chatId) throw new Error(`${label}: chatId is required`);
    const key = `${queue}.${subQueue}:${chatId}`;
    if (seen.has(key)) throw new Error(`Duplicate subscription: ${key}`);
    seen.add(key);
    all.push({ queue, subQueue, chatId, settings: validateSettings(value.settings, label), enabled });
  }

  if (isObject(data?.queues)) {
    for (const [key, entry] of Object.entries(data.queues)) {
      const match = /^([1-6])\.([12])$/.exec(key);
      if (!match) throw new Error(`Invalid queue key: ${key}`);
      if (!isObject(entry) || typeof entry.enabled !== "boolean") {
        throw new Error(`Queue ${key}: enabled must be a boolean`);
      }
      if (Object.hasOwn(entry, "chats") && Object.hasOwn(entry, "chatIds")) {
        throw new Error(`Queue ${key}: use chats or chatIds, not both`);
      }
      const values = entry.chats ?? entry.chatIds ?? [];
      if (!Array.isArray(values) || (entry.enabled && values.length === 0)) {
        throw new Error(`Queue ${key}: chats or chatIds must be a non-empty array when enabled`);
      }
      for (const [index, value] of values.entries()) {
        if (Object.hasOwn(entry, "chatIds") && typeof value !== "string") {
          throw new Error(`Queue ${key}: chatIds must contain strings`);
        }
        if (Object.hasOwn(entry, "chats") && !isObject(value)) {
          throw new Error(`Queue ${key}: chats must contain objects`);
        }
        add(Number(match[1]), Number(match[2]), typeof value === "string" ? { chatId: value } : value,
          `Queue ${key} chat ${index + 1}`, entry.enabled);
      }
    }
  } else if (Array.isArray(data?.subscriptions) && data.subscriptions.length) {
    for (const [index, value] of data.subscriptions.entries()) {
      add(value?.queue, value?.subQueue, value, `Subscription ${index + 1}`);
    }
  } else {
    throw new Error("Light subscriptions JSON needs a queues object or non-empty subscriptions array");
  }
  if (requireEnabled && !all.some(item => item.enabled)) {
    throw new Error("Light subscriptions have no enabled destinations");
  }
  return all;
}

function parseSubscriptions(data) {
  return collectSubscriptions(data).filter(item => item.enabled)
    .map(({ enabled, ...subscription }) => subscription);
}

function normalizeSubscriptions(data, options) {
  const all = collectSubscriptions(data, options);
  const queues = {};
  for (let queue = 1; queue <= 6; queue += 1) {
    for (let subQueue = 1; subQueue <= 2; subQueue += 1) {
      queues[`${queue}.${subQueue}`] = { enabled: false, chats: [] };
    }
  }
  if (isObject(data.queues)) {
    for (const [key, entry] of Object.entries(data.queues)) queues[key].enabled = entry.enabled;
  }
  for (const item of all) {
    const entry = queues[`${item.queue}.${item.subQueue}`];
    entry.enabled ||= item.enabled;
    entry.chats.push({ chatId: item.chatId, settings: item.settings });
  }
  return { queues };
}

async function loadSubscriptions(filePath) {
  let data;
  try {
    data = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read light subscriptions at ${filePath}: ${error.message}`);
  }
  return parseSubscriptions(data);
}

module.exports = { SETTING_FIELDS, validateSettings, parseSubscriptions, normalizeSubscriptions, loadSubscriptions };
