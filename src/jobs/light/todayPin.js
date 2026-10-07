"use strict";

const { requestWithRetry } = require("../../lib/httpClient");
const { readJobState, writeJobState } = require("../../lib/stateStore");
const { sendTelegramNotification, telegramCaptionLength } = require("../../lib/telegramNotifier");
const { effectiveDay, effectiveSchedule } = require("./effectiveSchedule");
const { buildDayLightNotification } = require("./messageCatalog");
const { renderScheduleImage, renderVerticalScheduleImage } = require("./scheduleImage");

function pinKey(stateKey) {
  return `${stateKey}:today-pin`;
}

function fingerprint(state) {
  const day = effectiveDay(state.today, state.treatYellowAsGreen);
  return JSON.stringify(day.timePeriods.map(({ status, time, durationMinutes }) => ({
    status, time, durationMinutes
  })));
}

async function savePin(config, stateKey, pin) {
  await writeJobState(config.job.stateFilePath, pinKey(stateKey), pin, pin.fingerprint);
}

async function rememberInitialTodayPost({ config, stateKey, currentState, previousDay, notification, message, kind }) {
  if (!config.job.pinTodaySchedule || notification.type !== "schedule-change:today" ||
      previousDay?.timePeriods?.length || !Number.isInteger(message?.message_id)) return;
  const existing = (await readJobState(config.job.stateFilePath, pinKey(stateKey)))?.state;
  await savePin(config, stateKey, {
    date: currentState.scheduleDate,
    messageId: message.message_id,
    kind,
    fingerprint: fingerprint(currentState),
    pinned: false,
    oldMessageId: existing?.pinned ? existing.messageId : existing?.oldMessageId
  });
}

async function telegramCall(config, method, body, deps) {
  const response = await requestWithRetry({
    method: "POST",
    url: `https://api.telegram.org/bot${config.telegram.botToken}/${method}`,
    headers: body instanceof FormData ? { Accept: "application/json" } :
      { "Content-Type": "application/json", Accept: "application/json" },
    body: body instanceof FormData ? body : JSON.stringify(body),
    timeoutMs: config.telegram.timeoutMs,
    maxRetries: config.telegram.maxRetries,
    retryBaseDelayMs: config.telegram.retryBaseDelayMs,
    responseType: "json",
    fetchImpl: deps.fetchImpl,
    logger: deps.logger
  });
  if (response.body?.ok !== true) throw new Error(`Telegram ${method} failed: ${response.body?.description || "unknown error"}`);
  return response.body.result;
}

async function snapshot(currentState, config) {
  const visible = effectiveSchedule(currentState, currentState.treatYellowAsGreen);
  const notification = {
    type: "schedule-change:today",
    text: buildDayLightNotification(visible, null, "today", { currentSchedule: true })
  };
  if (config.job.scheduleImageEnabled) {
    const render = config.job.scheduleImageLayout === "vertical"
      ? renderVerticalScheduleImage : renderScheduleImage;
    notification.photo = await render({
      queue: currentState.queue, subQueue: currentState.subQueue,
      day: "today", current: visible.today, scheduleDate: currentState.scheduleDate
    });
  }
  return notification;
}

async function postSnapshot({ config, stateKey, currentState, deps, oldPin, notification }) {
  let sent;
  await sendTelegramNotification(notification || await snapshot(currentState, config), config.telegram, {
    ...deps, onSent(message, kind) { sent = { messageId: message?.message_id, kind }; }
  });
  if (!Number.isInteger(sent?.messageId)) throw new Error("Telegram send response has no message_id for today pin");
  const pin = {
    date: currentState.scheduleDate, messageId: sent.messageId, kind: sent.kind,
    fingerprint: fingerprint(currentState), pinned: false,
    oldMessageId: oldPin?.pinned ? oldPin.messageId : oldPin?.oldMessageId
  };
  await savePin(config, stateKey, pin);
  return pin;
}

async function syncTodayPin({ config, stateKey, currentState, deps, replacementCount = 0 }) {
  if (!config.job.pinTodaySchedule || !currentState.today?.timePeriods?.length) return;
  const key = pinKey(stateKey);
  let pin = (await readJobState(config.job.stateFilePath, key))?.state;
  const desiredFingerprint = fingerprint(currentState);
  if (!pin?.messageId || pin.date !== currentState.scheduleDate) {
    pin = await postSnapshot({ config, stateKey, currentState, deps, oldPin: pin });
  }
  if (!pin.pinned) {
    try {
      await telegramCall(config, "pinChatMessage", {
        chat_id: config.telegram.chatId, message_id: pin.messageId, disable_notification: true
      }, deps);
    } catch (error) {
      const description = error.body?.description || "";
      if (/message to pin not found|message not found/i.test(description)) {
        if (replacementCount >= 1) throw error;
        await postSnapshot({ config, stateKey, currentState, deps, oldPin: pin });
        return syncTodayPin({ config, stateKey, currentState, deps, replacementCount: replacementCount + 1 });
      }
      if (!/already pinned/i.test(description)) throw error;
    }
    pin.pinned = true;
    await savePin(config, stateKey, pin);
  }
  if (pin.fingerprint !== desiredFingerprint) {
    const notification = await snapshot(currentState, config);
    if (pin.kind === "photo" && telegramCaptionLength(notification.text) > 1024) {
      if (replacementCount >= 1) throw new Error("Cannot fit current schedule in the pinned photo caption");
      pin = await postSnapshot({ config, stateKey, currentState, deps, oldPin: pin, notification });
      return syncTodayPin({ config, stateKey, currentState, deps, replacementCount: replacementCount + 1 });
    }
    try {
      if (pin.kind === "photo") {
        if (!notification.photo) throw new Error("Cannot update pinned photo without a rendered schedule image");
        const body = new FormData();
        body.set("chat_id", config.telegram.chatId);
        body.set("message_id", String(pin.messageId));
        body.set("media", JSON.stringify({
          type: "photo", media: "attach://schedule", caption: notification.text, parse_mode: "HTML"
        }));
        body.set("schedule", new Blob([notification.photo], { type: "image/png" }), "schedule.png");
        await telegramCall(config, "editMessageMedia", body, deps);
      } else {
        await telegramCall(config, "editMessageText", {
          chat_id: config.telegram.chatId, message_id: pin.messageId,
          text: notification.text, parse_mode: "HTML"
        }, deps);
      }
    } catch (error) {
      const description = error.body?.description || "";
      if (!/message is not modified/i.test(description)) {
        if (!/message to edit not found|message can't be edited/i.test(description)) throw error;
        if (replacementCount >= 1) throw error;
        await postSnapshot({ config, stateKey, currentState, deps, oldPin: pin, notification });
        return syncTodayPin({ config, stateKey, currentState, deps, replacementCount: replacementCount + 1 });
      }
    }
    pin.fingerprint = desiredFingerprint;
    await savePin(config, stateKey, pin);
  }
  if (pin.oldMessageId && pin.oldMessageId !== pin.messageId) {
    try {
      await telegramCall(config, "unpinChatMessage", {
        chat_id: config.telegram.chatId, message_id: pin.oldMessageId
      }, deps);
    } catch (error) {
      if (!/message to unpin not found|message not found/i.test(error.body?.description || "")) throw error;
    }
    delete pin.oldMessageId;
    await savePin(config, stateKey, pin);
  }
}

module.exports = { rememberInitialTodayPost, syncTodayPin };
