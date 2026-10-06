"use strict";

const { readFile } = require("fs/promises");
const { HttpRequestError } = require("../../lib/httpClient");
const { loadLightConfig } = require("./config");
const { describeLightScheduleChange } = require("./geminiClient");
const { buildLightNotification, buildOutageReminderNotification } = require("./messageCatalog");
const { parseLightSchedule } = require("./parser");

function encodePostBody(body) {
  if (typeof body === "string") {
    return body;
  }

  return `disconn=${encodeURIComponent(JSON.stringify(body))}`;
}

async function fetchPoeData(config, deps) {
  const postBody = encodePostBody(config.poe.postBody);

  const [getResponse, postResponse] = await Promise.all([
    deps.requestWithRetry({
      url: config.poe.url,
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml",
        "User-Agent": "alerts-tg-bot/1.0"
      },
      timeoutMs: config.poe.timeoutMs,
      maxRetries: config.poe.maxRetries,
      retryBaseDelayMs: config.poe.retryBaseDelayMs,
      responseType: "text",
      fetchImpl: deps.fetchImpl,
      logger: deps.logger
    }),
    deps.requestWithRetry({
      method: "POST",
      url: config.poe.postUrl,
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "User-Agent": "alerts-tg-bot/1.0"
      },
      body: postBody,
      timeoutMs: config.poe.timeoutMs,
      maxRetries: config.poe.maxRetries,
      retryBaseDelayMs: config.poe.retryBaseDelayMs,
      responseType: "text",
      fetchImpl: deps.fetchImpl,
      logger: deps.logger
    })
  ]);

  return {
    html: getResponse.body,
    getStatus: getResponse.status,
    postStatus: postResponse.status
  };
}

async function readStubData(config) {
  try {
    const html = await readFile(config.job.stubFilePath, "utf8");
    return {
      html,
      getStatus: 200,
      postStatus: null
    };
  } catch (error) {
    throw new HttpRequestError(`Failed to read light stub file: ${config.job.stubFilePath}`, {
      cause: error,
      retriable: false
    });
  }
}

function normalizeScheduleForFingerprint(schedule) {
  return {
    queue: schedule.queue,
    subQueue: schedule.subQueue,
    today: schedule.today.timePeriods.map(({ status, time, durationMinutes }) => ({
      status,
      time,
      durationMinutes
    })),
    tomorrow: schedule.tomorrow.timePeriods.map(({ status, time, durationMinutes }) => ({
      status,
      time,
      durationMinutes
    }))
  };
}

function getCurrentMinute(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes();
}

function getLocalDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate()
  ).padStart(2, "0")}`;
}

function dateFromCurrentMinute(currentMinute) {
  const date = new Date();
  date.setHours(Math.floor(currentMinute / 60), currentMinute % 60, 0, 0);
  return date;
}

function getSentOutageReminderIds(previousState) {
  const sentIds = previousState?.outageReminders?.sentIds;
  return Array.isArray(sentIds) ? sentIds.filter((id) => typeof id === "string") : [];
}

function buildOutageReminderId(outage, date = getLocalDate()) {
  return `${date}:${outage.kind || "off"}:${outage.startMin}-${outage.endMin}`;
}

function followingDate(date) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

function findPendingOutageReminder({ currentState, previousState, thresholdMinutes }) {
  if (!thresholdMinutes || thresholdMinutes <= 0) {
    return null;
  }

  const sentIds = new Set(getSentOutageReminderIds(previousState));
  const today = currentState.today.timePeriods;
  const tomorrow = currentState.tomorrow?.timePeriods || [];
  const scheduleDate = currentState.scheduleDate || getLocalDate();
  for (const [day, periods, offset] of [["today", today, 0], ["tomorrow", tomorrow, 1440]]) {
    for (const [index, period] of periods.entries()) {
      const previousPeriod = index > 0 ? periods[index - 1] : day === "tomorrow" ? today.at(-1) : null;
      const state = period.state || period.status;
      const previousStatus = previousPeriod?.state || previousPeriod?.status;
      const kind = state === 2 && previousStatus !== 2 ? "off" :
        [1, 3].includes(state) && previousStatus === 2 ? "on" : null;
      if (!kind || !Number.isInteger(period.startMin) || !Number.isInteger(period.endMin)) continue;
      const minutesUntilStart = period.startMin + offset - currentState.currentMinute;
      if (minutesUntilStart <= 0 || minutesUntilStart > thresholdMinutes) continue;
      const id = buildOutageReminderId(
        { ...period, kind },
        day === "today" ? scheduleDate : followingDate(scheduleDate)
      );
      if (sentIds.has(id)) continue;
      return {
        id,
        day,
        kind,
        tentative: state === 3,
        startMin: period.startMin,
        endMin: period.endMin,
        time: period.time,
        minutesUntilStart
      };
    }
  }
  return null;
}

function markOutageReminderSent(currentState) {
  if (!currentState.pendingOutageReminder) {
    return currentState;
  }

  const sentIds = new Set(currentState.outageReminders?.sentIds || []);
  sentIds.add(currentState.pendingOutageReminder.id);

  return {
    ...currentState,
    pendingOutageReminder: null,
    outageReminders: {
      sentIds: Array.from(sentIds).slice(-50)
    }
  };
}

const lightPlugin = {
  name: "light",

  loadConfig: loadLightConfig,

  getLockFilePath(config) {
    return config.job.lockFilePath;
  },

  getStateFilePath(config) {
    return config.job.stateFilePath;
  },

  getStateKey(config) {
    return `light:${config.poe.queue}.${config.poe.subQueue}`;
  },

  async fetchCurrent(config, deps) {
    deps.logger.info("Starting light polling job", {
      url: config.poe.url,
      postUrl: config.poe.postUrl,
      queue: config.poe.queue,
      subQueue: config.poe.subQueue,
      useStub: config.job.useStub
    });

    const response = config.job.useStub
      ? await readStubData(config)
      : await fetchPoeData(config, deps);

    if (config.job.useStub) {
      deps.logger.warn("Light stub mode enabled. External POE requests skipped", {
        stubFilePath: config.job.stubFilePath
      });
    }

    const currentMinute = Number.isInteger(config.job.currentMinute)
      ? config.job.currentMinute
      : getCurrentMinute();
    const schedule = parseLightSchedule(response.html, config.poe.queue, config.poe.subQueue, {
      now: dateFromCurrentMinute(currentMinute)
    });

    const currentState = {
      ...schedule,
      sourceUrl: config.poe.url,
      source: config.job.useStub ? "stub" : "poe",
      currentMinute,
      scheduleDate: getLocalDate(),
      responseStatus: response.getStatus,
      postResponseStatus: response.postStatus,
      outageReminders: {
        sentIds: getSentOutageReminderIds(deps.previousState)
      }
    };
    currentState.pendingOutageReminder = findPendingOutageReminder({
      currentState,
      previousState: deps.previousState,
      thresholdMinutes: config.job.outageReminderBeforeMinutes
    });

    deps.logger.info("Light data fetched successfully", {
      queue: config.poe.queue,
      subQueue: config.poe.subQueue,
      responseStatus: response.getStatus,
      postResponseStatus: response.postStatus,
      updatedAt: currentState.updatedAt,
      todayPeriods: currentState.today.timePeriods.length,
      tomorrowPeriods: currentState.tomorrow.timePeriods.length,
      outageReminderBeforeMinutes: config.job.outageReminderBeforeMinutes,
      pendingOutageReminder: currentState.pendingOutageReminder
    });

    return currentState;
  },

  getStateFingerprint(state) {
    return JSON.stringify(normalizeScheduleForFingerprint(state));
  },

  shouldNotify({ changed, config, currentState }) {
    return changed || config.job.alwaysSendTgMessage || Boolean(currentState.pendingOutageReminder);
  },

  async buildNotification({ previousState, currentState, changed, config, deps }) {
    let changeSummary = "";
    const notifications = [];

    if (!changed) {
      deps.logger.info("Gemini change summary skipped", {
        reason: "schedule-unchanged",
        queue: currentState.queue,
        subQueue: currentState.subQueue
      });
    } else if (!previousState) {
      deps.logger.info("Gemini change summary skipped", {
        reason: "missing-previous-state",
        queue: currentState.queue,
        subQueue: currentState.subQueue
      });
    } else if (!config.gemini.enabled) {
      deps.logger.info("Gemini change summary skipped", {
        reason: "disabled",
        queue: currentState.queue,
        subQueue: currentState.subQueue
      });
    } else {
      try {
        deps.logger.info("Requesting Gemini change summary", {
          model: config.gemini.model,
          queue: currentState.queue,
          subQueue: currentState.subQueue,
          previousUpdatedAt: previousState.updatedAt || null,
          currentUpdatedAt: currentState.updatedAt || null,
          previousTodayPeriods: previousState.today.timePeriods.length,
          currentTodayPeriods: currentState.today.timePeriods.length,
          previousTomorrowPeriods: previousState.tomorrow.timePeriods.length,
          currentTomorrowPeriods: currentState.tomorrow.timePeriods.length
        });

        changeSummary = await describeLightScheduleChange(
          config.gemini,
          previousState,
          currentState,
          deps
        );

        if (changeSummary) {
          deps.logger.info("Gemini change summary generated", {
            model: config.gemini.model,
            queue: currentState.queue,
            subQueue: currentState.subQueue,
            length: changeSummary.length
          });
        } else {
          deps.logger.warn("Gemini change summary response was empty", {
            model: config.gemini.model,
            queue: currentState.queue,
            subQueue: currentState.subQueue
          });
        }
      } catch (error) {
        deps.logger.warn("Gemini change summary failed; using raw schedule diff only", {
          model: config.gemini.model,
          queue: currentState.queue,
          subQueue: currentState.subQueue,
          reason: error.message,
          status: error.status,
          body: error.body
        });
      }
    }

    if (changed || config.job.alwaysSendTgMessage) {
      notifications.push({
        type: "schedule-change",
        text: buildLightNotification(currentState, changed ? previousState : null, {
          changeSummary
        })
      });
    }

    if (currentState.pendingOutageReminder) {
      notifications.push({
        type: "outage-reminder",
        text: buildOutageReminderNotification(currentState, currentState.pendingOutageReminder)
      });
    }

    return notifications;
  },

  async afterNotificationSuccess({ currentState, notifications }) {
    const reminderSent = notifications.some(
      (notification) => notification.type === "outage-reminder"
    );

    if (!currentState.pendingOutageReminder || !reminderSent) {
      return null;
    }

    return markOutageReminderSent(currentState);
  }
};

module.exports = {
  encodePostBody,
  buildOutageReminderId,
  dateFromCurrentMinute,
  findPendingOutageReminder,
  getCurrentMinute,
  markOutageReminderSent,
  readStubData,
  lightPlugin,
  normalizeScheduleForFingerprint
};
