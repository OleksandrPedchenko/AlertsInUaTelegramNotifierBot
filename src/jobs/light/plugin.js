"use strict";

const { readFile } = require("fs/promises");
const { HttpRequestError } = require("../../lib/httpClient");
const { loadLightConfig } = require("./config");
const { describeLightScheduleChange } = require("./geminiClient");
const { effectiveDay, effectiveSchedule } = require("./effectiveSchedule");
const { buildDayLightNotification, buildLightNotification, buildOutageReminderNotification } = require("./messageCatalog");
const { parseLightSchedule } = require("./parser");

async function fetchPoeData(config, deps) {
  const getResponse = await deps.requestWithRetry({
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
  });

  return {
    html: getResponse.body,
    getStatus: getResponse.status
  };
}

async function readStubData(config) {
  try {
    const html = await readFile(config.job.stubFilePath, "utf8");
    return {
      html,
      getStatus: 200
    };
  } catch (error) {
    throw new HttpRequestError(`Failed to read light stub file: ${config.job.stubFilePath}`, {
      cause: error,
      retriable: false
    });
  }
}

function normalizeScheduleForFingerprint(schedule) {
  schedule = effectiveSchedule(schedule, schedule.treatYellowAsGreen);
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

function dayFingerprint(schedule) {
  return JSON.stringify(schedule?.timePeriods?.map(({ status, time, durationMinutes }) => ({
    status, time, durationMinutes
  })) || []);
}

function previousScheduleForDay(previousState, currentState, day) {
  if (!previousState) return null;
  if (!previousState.scheduleDate || !currentState.scheduleDate) return previousState[day] || null;
  const targetDate = day === "today" ? currentState.scheduleDate : followingDate(currentState.scheduleDate);
  if (targetDate === previousState.scheduleDate) return previousState.today || null;
  if (targetDate === followingDate(previousState.scheduleDate)) return previousState.tomorrow || null;
  return null;
}

function hasPublishedSchedule(day) {
  return Boolean(day?.timePeriods?.length);
}

function getChangedDays(previousState, currentState) {
  if (!previousState) return [];
  return ["today", "tomorrow"].filter(day =>
    dayFingerprint(effectiveDay(previousScheduleForDay(previousState, currentState, day), currentState.treatYellowAsGreen)) !==
    dayFingerprint(effectiveDay(currentState[day], currentState.treatYellowAsGreen))
  );
}

function findPendingOutageReminder({ currentState, previousState, thresholdMinutes }) {
  if (!thresholdMinutes || thresholdMinutes <= 0) {
    return null;
  }

  const sentIds = new Set(getSentOutageReminderIds(previousState));
  const visibleSchedule = effectiveSchedule(currentState, currentState.treatYellowAsGreen);
  const today = visibleSchedule.today.timePeriods;
  const tomorrow = visibleSchedule.tomorrow?.timePeriods || [];
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

function buildCurrentLightState(schedule, config, previousState, response) {
  const currentMinute = Number.isInteger(config.job.currentMinute)
    ? config.job.currentMinute : getCurrentMinute();
  const currentState = {
    ...schedule,
    sourceUrl: config.poe.url,
    source: config.job.useStub ? "stub" : "poe",
    treatYellowAsGreen: config.job.treatYellowAsGreen,
    currentMinute,
    scheduleDate: getLocalDate(),
    responseStatus: response.getStatus,
    outageReminders: { sentIds: getSentOutageReminderIds(previousState) }
  };
  currentState.pendingOutageReminder = findPendingOutageReminder({
    currentState,
    previousState,
    thresholdMinutes: config.job.outageReminderBeforeMinutes
  });
  return currentState;
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
      ? config.job.currentMinute : getCurrentMinute();
    const schedule = parseLightSchedule(response.html, config.poe.queue, config.poe.subQueue, {
      now: dateFromCurrentMinute(currentMinute)
    });
    const currentState = buildCurrentLightState(schedule, config, deps.previousState, response);

    deps.logger.info("Light data fetched successfully", {
      queue: config.poe.queue,
      subQueue: config.poe.subQueue,
      responseStatus: response.getStatus,
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

  shouldNotify({ previousState, config, currentState }) {
    return !previousState || getChangedDays(previousState, currentState).length > 0 ||
      config.job.alwaysSendTgMessage || Boolean(currentState.pendingOutageReminder);
  },

  async buildNotification({ previousState, currentState, changed, config, deps }) {
    const visibleState = effectiveSchedule(currentState, currentState.treatYellowAsGreen);
    const changedDays = getChangedDays(previousState, currentState);
    const revisedDays = changedDays.filter(day =>
      hasPublishedSchedule(previousScheduleForDay(previousState, currentState, day))
    );
    const summaries = { ...(deps.changeSummaries || {}) };
    const notifications = [];

    if (!previousState) {
      deps.logger.info("Gemini change summary skipped", {
        reason: "missing-previous-state",
        queue: currentState.queue,
        subQueue: currentState.subQueue
      });
    } else if (changedDays.length === 0) {
      deps.logger.info("Gemini change summary skipped", {
        reason: "schedule-unchanged",
        queue: currentState.queue,
        subQueue: currentState.subQueue
      });
    } else if (revisedDays.length === 0) {
      deps.logger.info("Gemini change summary skipped", {
        reason: "schedule-first-published",
        queue: currentState.queue,
        subQueue: currentState.subQueue
      });
    } else if (deps.changeSummaries !== undefined) {
      // A fan-out run already made its single Gemini batch request.
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

        const firstDay = revisedDays[0];
        const priorForPrompt = {
          ...previousState,
          today: previousScheduleForDay(previousState, currentState, "today") || { timePeriods: [] },
          tomorrow: previousScheduleForDay(previousState, currentState, "tomorrow") || { timePeriods: [] }
        };
        summaries[firstDay] = await describeLightScheduleChange(
          config.gemini,
          effectiveSchedule(priorForPrompt, currentState.treatYellowAsGreen),
          visibleState,
          deps
        );

        if (summaries[firstDay]) {
          deps.logger.info("Gemini change summary generated", {
            model: config.gemini.model,
            queue: currentState.queue,
            subQueue: currentState.subQueue,
            length: summaries[firstDay].length
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

    if (!previousState || (changedDays.length === 0 && config.job.alwaysSendTgMessage)) {
      notifications.push({
        type: "schedule-change",
        text: buildLightNotification(visibleState, null, {
          collapseSchedule: Boolean(previousState)
        })
      });
    } else {
      for (const day of changedDays) {
        const previousDay = previousScheduleForDay(previousState, currentState, day);
        notifications.push({
          type: `schedule-change:${day}`,
          text: buildDayLightNotification(
            visibleState,
            hasPublishedSchedule(previousDay)
              ? effectiveDay(previousDay, currentState.treatYellowAsGreen) : null,
            day,
            { changeSummary: summaries[day] }
          )
        });
      }
    }

    if (currentState.pendingOutageReminder) {
      notifications.push({
        type: "outage-reminder",
        text: buildOutageReminderNotification(visibleState, currentState.pendingOutageReminder)
      });
    }

    return notifications;
  },

  async afterNotificationSuccess({ previousState, currentState, notifications, deps }) {
    const sentDay = notifications[0]?.type?.split(":")[1];
    if (sentDay && previousState) {
      const sentDays = deps.sentScheduleDays || new Set();
      sentDays.add(sentDay);
      deps.sentScheduleDays = sentDays;
      const unsentDays = getChangedDays(previousState, currentState).filter(day => !sentDays.has(day));
      if (unsentDays.length > 0) {
        const saved = { ...currentState };
        for (const day of unsentDays) {
          saved[day] = previousScheduleForDay(previousState, currentState, day) || {
            timePeriods: [], totalTimeOn: 0, totalTimeOff: 0
          };
        }
        return saved;
      }
    }
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
  buildCurrentLightState,
  dayFingerprint,
  getChangedDays,
  previousScheduleForDay,
  fetchPoeData,
  buildOutageReminderId,
  dateFromCurrentMinute,
  findPendingOutageReminder,
  getCurrentMinute,
  markOutageReminderSent,
  readStubData,
  lightPlugin,
  normalizeScheduleForFingerprint
};
