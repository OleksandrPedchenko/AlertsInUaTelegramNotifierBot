"use strict";

const { prettyTime } = require("./parser");

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatPeriod(period, markCurrent = true) {
  const currentMarker = period.current && markCurrent ? " ✅" : "";
  return `${escapeHtml(period.time)}${currentMarker} (${prettyTime(period.durationMinutes)}) — ${escapeHtml(
    period.statusLabel
  )}`;
}

function formatOutageReminder(reminder) {
  return [
    `<b>Нагадування про відключення</b>`,
    `З ${escapeHtml(reminder.time)} буде відключення світла.`,
    `Початок через ${escapeHtml(reminder.minutesUntilStart)} хв.`
  ];
}

function formatPeriods(title, periods, options = {}) {
  if (!periods.length) {
    return [`<b>${escapeHtml(title)}</b>`, "No data..."];
  }

  return [
    `<b>${escapeHtml(title)}</b>`,
    ...periods.map((period) => formatPeriod(period, options.markCurrent !== false))
  ];
}

function buildScheduleDetails(state, options = {}) {
  const lines = [];
  const currentPeriod = state.today.timePeriods.find((period) => period.current);

  if (currentPeriod && options.includeCurrent !== false) {
    lines.push(`Зараз: ${formatPeriod(currentPeriod, false)}`);
    lines.push("");
  }

  lines.push(...formatPeriods("Сьогодні", state.today.timePeriods));
  lines.push(
    `Разом: +${prettyTime(state.today.totalTimeOn)} -${prettyTime(state.today.totalTimeOff)}`
  );

  if (state.tomorrow.timePeriods.length) {
    lines.push("");
    lines.push(...formatPeriods("Завтра", state.tomorrow.timePeriods, { markCurrent: false }));
    lines.push(
      `Разом завтра: +${prettyTime(state.tomorrow.totalTimeOn)} -${prettyTime(
        state.tomorrow.totalTimeOff
      )}`
    );
  }

  if (state.updatedAt) {
    lines.push("");
    lines.push(`Оновлено на сайті: ${escapeHtml(state.updatedAt)}`);
  }

  return lines;
}

function buildLightNotification(currentState, previousState = null, options = {}) {
  const lines = [
    `<b>Графік світла: ${escapeHtml(currentState.queue)}.${escapeHtml(currentState.subQueue)} черга</b>`
  ];

  if (previousState) {
    if (options.changeSummary) {
      lines.push("");
      lines.push("<b>Що змінилось</b>");
      lines.push(escapeHtml(options.changeSummary));
    }

    lines.push("");
    lines.push("<b>Було</b>");
    lines.push(...buildScheduleDetails(previousState, { includeCurrent: false }));

    lines.push("");
    lines.push("<b>Стало</b>");
    lines.push(...buildScheduleDetails(currentState));
  } else {
    lines.push("");
    lines.push(...buildScheduleDetails(currentState));
  }

  lines.push("");
  lines.push(`Джерело: ${escapeHtml(currentState.sourceUrl)}`);
  return lines.join("\n");
}

function buildOutageReminderNotification(currentState, reminder) {
  return [
    `<b>Графік світла: ${escapeHtml(currentState.queue)}.${escapeHtml(currentState.subQueue)} черга</b>`,
    "",
    ...formatOutageReminder(reminder),
    "",
    `Джерело: ${escapeHtml(currentState.sourceUrl)}`
  ].join("\n");
}

module.exports = {
  buildOutageReminderNotification,
  buildScheduleDetails,
  buildLightNotification,
  escapeHtml,
  formatOutageReminder,
  formatPeriod
};
