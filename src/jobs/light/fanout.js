"use strict";

const { createHash } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { createEnvReader } = require("../../lib/config");
const { requestWithRetry } = require("../../lib/httpClient");
const { acquireRunLock } = require("../../lib/lock");
const { createLogger } = require("../../lib/logger");
const { normalizeNotifications } = require("../../lib/runner");
const { readJobState, writeJobState } = require("../../lib/stateStore");
const { sendTelegramNotification } = require("../../lib/telegramNotifier");
const { loadLightConfig } = require("./config");
const { buildGeminiUrl, changedWindowsForPrompt, extractGeminiText, trimPeriodsForPrompt } = require("./geminiClient");
const { effectiveDay } = require("./effectiveSchedule");
const { parseLightSchedule } = require("./parser");
const { buildCurrentLightState, dateFromCurrentMinute, dayFingerprint, fetchPoeData, getRelevantChangedDays, getCurrentMinute, lightPlugin, previousScheduleForDay, readStubData } = require("./plugin");

async function loadSubscriptions(filePath) {
  let data;
  try {
    data = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read light subscriptions at ${filePath}: ${error.message}`);
  }
  const seen = new Set();
  function addSubscription(item, label) {
    const queue = item?.queue;
    const subQueue = item?.subQueue;
    const chatId = typeof item?.chatId === "string" ? item.chatId.trim() : "";
    if (!Number.isInteger(queue) || queue < 1 || queue > 6) {
      throw new Error(`${label}: queue must be an integer from 1 to 6`);
    }
    if (!Number.isInteger(subQueue) || subQueue < 1 || subQueue > 2) {
      throw new Error(`${label}: subQueue must be 1 or 2`);
    }
    if (!chatId) throw new Error(`${label}: chatId is required`);
    const key = `${queue}.${subQueue}:${chatId}`;
    if (seen.has(key)) throw new Error(`Duplicate subscription: ${key}`);
    seen.add(key);
    return { queue, subQueue, chatId };
  }

  if (data?.queues && !Array.isArray(data.queues) && typeof data.queues === "object") {
    const subscriptions = [];
    for (const [key, entry] of Object.entries(data.queues)) {
      const match = key.match(/^([1-6])\.([12])$/);
      if (!match) throw new Error(`Invalid queue key: ${key}`);
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.enabled !== "boolean") {
        throw new Error(`Queue ${key}: enabled must be a boolean`);
      }
      const chatIds = entry.chatIds ?? [];
      if (!Array.isArray(chatIds) || (entry.enabled && chatIds.length === 0)) {
        throw new Error(`Queue ${key}: chatIds must be a non-empty array when enabled`);
      }
      for (const chatId of chatIds) {
        if (entry.enabled) {
          subscriptions.push(addSubscription({
            queue: Number(match[1]), subQueue: Number(match[2]), chatId
          }, `Queue ${key}`));
        } else if (typeof chatId !== "string" || !chatId.trim()) {
          throw new Error(`Queue ${key}: chatIds must contain non-empty strings`);
        }
      }
    }
    if (subscriptions.length === 0) throw new Error("Light subscriptions have no enabled destinations");
    return subscriptions;
  }

  if (!data || !Array.isArray(data.subscriptions) || data.subscriptions.length === 0) {
    throw new Error("Light subscriptions JSON needs a queues object or non-empty subscriptions array");
  }
  return data.subscriptions.map((item, index) => addSubscription(item, `Subscription ${index + 1}`));
}

function changeCacheKey(item) {
  const oldFingerprint = dayFingerprint(item.previousDay);
  const newFingerprint = dayFingerprint(item.currentDay);
  const timeSlot = item.day === "today" ? Math.floor(item.currentState.currentMinute / 30) : "tomorrow";
  const digest = createHash("sha256").update(`${item.currentState.scheduleDate}:${timeSlot}\n${oldFingerprint}\n${newFingerprint}`).digest("hex");
  return `light:gemini:${item.queueKey}:${item.day}:${digest}`;
}

function batchPrompt(items) {
  const treatYellowAsGreen = items[0]?.currentState.treatYellowAsGreen;
  const changes = items.map(item => ({
    id: item.batchId,
    day: item.day,
    currentMinute: item.day === "today" ? item.currentState.currentMinute : null,
    old: trimPeriodsForPrompt(item.previousDay.timePeriods, item.day === "today" ? item.currentState.currentMinute : null),
    now: trimPeriodsForPrompt(item.currentDay.timePeriods, item.day === "today" ? item.currentState.currentMinute : null),
    changes: changedWindowsForPrompt(item.previousDay.timePeriods, item.currentDay.timePeriods,
      item.day === "today" ? item.currentState.currentMinute : null)
  }));
  return [
    "Поясни українською лише зміни з поля changes окремо для кожного id. old і now — контекст, не шукай у них додаткових змін.",
    treatYellowAsGreen
      ? "Стани: 1=світло є (включно з жовтим періодом POE), 2=немає."
      : "Стани: 1=світло є, 2=немає, 3=невизначений час повернення світла одразу після червоного відключення.",
    "Найчастіша зміна — червоний період став довшим або коротшим. Порівнюй початок і кінець старого та нового відключення; називай старий і новий час.",
    "Для продовження: 🔴 Відключення продовжено до HH:MM (було до HH:MM).",
    treatYellowAsGreen
      ? "Для скорочення: 🟢 Відключення скорочено до HH:MM (було до HH:MM)."
      : "Для скорочення, якщо після червоного йде стан 3: 🟡 Відключення скорочено до HH:MM (було до HH:MM). Світло може з’явитися раніше.",
    ...(!treatYellowAsGreen
      ? ["Для скорочення, якщо новий стан 1: 🟢 Відключення скорочено до HH:MM (було до HH:MM)."]
      : []),
    treatYellowAsGreen
      ? "У звичайному шестигодинному циклі початок відключення не змінюється: змінюється лише кінець червоного періоду, після якого світло вважається наявним."
      : "У звичайному шестигодинному циклі початок відключення не змінюється: змінюється лише кінець червоного періоду, за ним іде 30 хвилин невизначеного повернення світла, потім зелений період.",
    "Якщо дані все ж показують нове чи скасоване відключення, опиши фактичну зміну без вигаданої причини.",
    "Один короткий рядок на кожну суттєву зміну. Після старого й нового часу завершення відключення не додавай другу фразу про наявність світла. Не дублюй зміну сусіднього зеленого чи невизначеного періоду окремим рядком.",
    "Якщо змінилися два або більше відключень, опиши кожне змінене відключення окремим рядком у часовому порядку.",
    treatYellowAsGreen
      ? "Жовтий період POE тут свідомо вважається часом зі світлом. Не вигадуй причини, поради чи зміни, яких немає."
      : "Не обіцяй, що світло точно буде у стані 3. Не вигадуй причини, поради чи зміни, яких немає.",
    "Для сьогодні передані сегменти від попереднього 30-хвилинного слота. Не описуй зміни, що повністю минули до currentMinute, але збережи повний початок і старий/новий кінець актуального відключення. Для завтра аналізуй всю добу.",
    "Відповідь: лише JSON object, де ключ — точний id, значення — короткий текст про зміни без заголовка.",
    JSON.stringify(changes)
  ].join("\n");
}

async function describeBatch(config, items, deps) {
  const response = await requestWithRetry({
    method: "POST",
    url: buildGeminiUrl(config),
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: batchPrompt(items) }] }],
      generationConfig: {
        temperature: config.temperature,
        maxOutputTokens: config.maxOutputTokens,
        responseMimeType: "application/json"
      }
    }),
    timeoutMs: config.timeoutMs,
    maxRetries: 0,
    retryBaseDelayMs: config.retryBaseDelayMs,
    responseType: "json",
    fetchImpl: deps.fetchImpl,
    logger: deps.logger
  });
  const parsed = JSON.parse(extractGeminiText(response.body));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Gemini batch response must be a JSON object");
  }
  return parsed;
}

async function prepareGeminiSummaries(items, config, deps) {
  const summaries = new Map();
  if (!config.gemini.enabled) return summaries;
  const cacheKey = "light:gemini-cache";
  const cache = { ...((await readJobState(config.job.stateFilePath, cacheKey))?.state?.entries || {}) };
  const unique = new Map();
  for (const item of items) {
    item.changeCacheKeys = {};
    if (!item.previousState) continue;
    for (const day of getRelevantChangedDays(item.previousState, item.currentState)) {
      const previousDay = previousScheduleForDay(item.previousState, item.currentState, day);
      if (!previousDay?.timePeriods?.length) continue;
      const change = { ...item, day,
        previousDay: effectiveDay(previousDay, item.currentState.treatYellowAsGreen),
        currentDay: effectiveDay(item.currentState[day], item.currentState.treatYellowAsGreen) };
      const key = changeCacheKey(change);
      item.changeCacheKeys[day] = key;
      change.changeCacheKey = key;
      if (!unique.has(key)) unique.set(key, change);
    }
  }
  const missing = [];
  for (const [key, item] of unique) {
    const cached = cache[key];
    if (typeof cached?.summary === "string") {
      summaries.set(key, cached.summary);
    } else if (!cached?.retryAfter || Date.now() >= cached.retryAfter) {
      item.batchId = `${item.queueKey}:${item.day}`;
      if (missing.some(other => other.batchId === item.batchId)) item.batchId = `${item.queueKey}#${missing.length + 1}`;
      missing.push(item);
    }
  }
  if (missing.length === 0) return summaries;
  const now = Date.now();
  const controlKey = "light:gemini-control";
  const previousAttempts = (await readJobState(config.job.stateFilePath, controlKey))?.state?.attempts;
  const attempts = (Array.isArray(previousAttempts) ? previousAttempts : [])
    .filter(value => Number.isFinite(value) && value > now - 24 * 60 * 60 * 1000);
  if (attempts.length >= config.gemini.maxDailyRequests ||
      (attempts.length > 0 && now - attempts.at(-1) < config.gemini.minIntervalMinutes * 60 * 1000)) {
    deps.logger.info("Gemini batch skipped by request budget", {
      attemptsLast24Hours: attempts.length,
      minIntervalMinutes: config.gemini.minIntervalMinutes,
      maxDailyRequests: config.gemini.maxDailyRequests
    });
    return summaries;
  }
  attempts.push(now);
  await writeJobState(config.job.stateFilePath, controlKey, { attempts }, "v1");
  try {
    deps.logger.info("Requesting Gemini summaries for changed queues", { count: missing.length });
    const response = await describeBatch(config.gemini, missing, deps);
    for (const item of missing) {
      const summary = response[item.batchId];
      if (typeof summary !== "string" || !summary.trim()) {
        cache[item.changeCacheKey] = { retryAfter: now + 15 * 60 * 1000, savedAt: now };
        continue;
      }
      const clean = summary.trim();
      summaries.set(item.changeCacheKey, clean);
      cache[item.changeCacheKey] = { summary: clean, savedAt: now };
    }
  } catch (error) {
    deps.logger.warn("Gemini batch failed; using raw schedules", { reason: error.message, status: error.status });
    const retryAfter = now + 15 * 60 * 1000;
    for (const item of missing) {
      cache[item.changeCacheKey] = { retryAfter, savedAt: now };
    }
  }
  const entries = Object.fromEntries(Object.entries(cache)
    .sort(([, left], [, right]) => (left.savedAt || 0) - (right.savedAt || 0))
    .slice(-100));
  await writeJobState(config.job.stateFilePath, cacheKey, { entries }, "v1");
  return summaries;
}

async function runFanout(env = process.env, options = {}) {
  const cwd = options.cwd || process.cwd();
  const config = options.config || loadLightConfig(env, createEnvReader(env, { cwd }));
  if (!config.job.subscriptionsFilePath) throw new Error("LIGHT_SUBSCRIPTIONS_FILE is required for fan-out");
  const subscriptions = await loadSubscriptions(config.job.subscriptionsFilePath);
  const ownsLogger = !options.logger;
  const logger = options.logger || createLogger({ cwd, fetchImpl: options.fetchImpl, ...config.log });
  const release = await acquireRunLock(config.job.lockFilePath);
  if (!release) return { skipped: true };
  try {
    logger.info("Starting light fan-out", { jobName: "light", subscriptions: subscriptions.length });
    const deps = { logger, requestWithRetry, fetchImpl: options.fetchImpl };
    const response = config.job.useStub ? await readStubData(config) : await fetchPoeData(config, deps);
    logger.info("POE schedule fetched", { jobName: "light", responseStatus: response.getStatus });
    const currentMinute = Number.isInteger(config.job.currentMinute)
      ? config.job.currentMinute : getCurrentMinute();
    const schedules = new Map();
    for (const { queue, subQueue } of subscriptions) {
      const queueKey = `${queue}.${subQueue}`;
      if (!schedules.has(queueKey)) {
        schedules.set(queueKey, parseLightSchedule(response.html, queue, subQueue, {
          now: dateFromCurrentMinute(currentMinute)
        }));
      }
    }
    const items = [];
    for (const subscription of subscriptions) {
      const queueKey = `${subscription.queue}.${subscription.subQueue}`;
      const stateKey = `light:${queueKey}:chat:${subscription.chatId}`;
      const previousRecord = await readJobState(config.job.stateFilePath, stateKey);
      const previousState = previousRecord?.state || null;
      const subscriberConfig = {
        ...config,
        poe: { ...config.poe, queue: subscription.queue, subQueue: subscription.subQueue },
        telegram: { ...config.telegram, chatId: subscription.chatId }
      };
      const currentState = buildCurrentLightState(schedules.get(queueKey), subscriberConfig, previousState, response);
      const fingerprint = lightPlugin.getStateFingerprint(currentState);
      const previousFingerprint = previousRecord?.fingerprint ||
        (previousState && lightPlugin.getStateFingerprint(previousState));
      const changed = previousFingerprint !== fingerprint;
      items.push({ queueKey, stateKey, previousState, previousRecord, currentState,
        fingerprint, changed, config: subscriberConfig });
    }
    const summaries = await prepareGeminiSummaries(items, config, deps);
    const failures = [];
    let notificationCount = 0;
    const lastSentAt = new Map();
    for (const item of items) {
      try {
        if (!lightPlugin.shouldNotify({ previousState: item.previousState, changed: item.changed, config: item.config, currentState: item.currentState })) {
          await writeJobState(config.job.stateFilePath, item.stateKey, item.currentState, item.fingerprint);
          await lightPlugin.syncTodayPin({ config: item.config, stateKey: item.stateKey, currentState: item.currentState, deps });
          continue;
        }
        const deliveryDeps = {
          ...deps,
          changeSummaries: Object.fromEntries(["today", "tomorrow"].map(day =>
            [day, summaries.get(item.changeCacheKeys?.[day]) || ""]
          ))
        };
        const notifications = normalizeNotifications(await lightPlugin.buildNotification({
          previousState: item.previousState,
          currentState: item.currentState,
          changed: item.changed,
          config: item.config,
          deps: deliveryDeps
        }));
        for (const notification of notifications) {
          const chatId = item.config.telegram.chatId;
          const waitMs = 1100 - (Date.now() - (lastSentAt.get(chatId) || 0));
          if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
          const delivered = await sendTelegramNotification(notification, item.config.telegram, {
            ...deps,
            onSent: (message, kind) => lightPlugin.afterTelegramSend({
              config: item.config, stateKey: item.stateKey, previousState: item.previousState,
              currentState: item.currentState, notification, message, kind, deps
            })
          });
          lastSentAt.set(chatId, Date.now());
          notificationCount += delivered;
          logger.info("Light notification delivered", {
            jobName: "light", queue: item.queueKey, chatId, type: notification.type
          });
          const updated = await lightPlugin.afterNotificationSuccess({
            previousState: item.previousState,
            currentState: item.currentState,
            notifications: [notification],
            deps: deliveryDeps
          });
          const savedState = updated || item.currentState;
          await writeJobState(config.job.stateFilePath, item.stateKey, savedState,
            lightPlugin.getStateFingerprint(savedState));
          await lightPlugin.syncTodayPin({ config: item.config, stateKey: item.stateKey, currentState: item.currentState, deps });
        }
      } catch (error) {
        failures.push(item.stateKey);
        logger.error("Light subscription failed", { jobName: "light", stateKey: item.stateKey, error });
      }
    }
    logger.info("Light fan-out completed", { jobName: "light", subscriptions: items.length, notificationCount, failures: failures.length });
    if (failures.length) throw new Error(`Failed light subscriptions: ${failures.join(", ")}`);
    return { skipped: false, subscriptions: items.length, notificationCount };
  } finally {
    await release();
    if (ownsLogger) await logger.flush?.();
  }
}

module.exports = { loadSubscriptions, runFanout };
