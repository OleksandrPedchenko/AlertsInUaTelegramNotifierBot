"use strict";

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatPeriod(period) {
  const emoji = { 1: "🟢", 2: "🔴", 3: "🟡" }[period.status || period.state] || "⚪";
  return `${emoji} ${escapeHtml(String(period.time).replace(" - ", "–"))} · ${escapeHtml(
    period.statusLabel
  )}`;
}

function formatOutageReminder(reminder) {
  const time = `${reminder.day === "tomorrow" ? "Завтра " : ""}${escapeHtml(
    String(reminder.time).replace(" - ", "–")
  )}`;
  const lead = escapeHtml(reminder.minutesUntilStart);
  if (reminder.kind === "on") {
    return [
      `${reminder.tentative ? "🟡 Світло може з’явитися" : "🟢 Світло з’явиться"} через ${lead} хв`,
      time
    ];
  }
  return [
    `🔴 Відключення через ${lead} хв`,
    time
  ];
}

function formatPeriods(title, periods) {
  if (!periods.length) {
    return [...(title ? [`<b>${escapeHtml(title)}</b>`] : []), "Немає даних"];
  }

  return [
    ...(title ? [`<b>${escapeHtml(title)}</b>`] : []),
    ...periods.map(formatPeriod)
  ];
}

function buildScheduleDetails(state) {
  const lines = [...formatPeriods("Сьогодні", state.today.timePeriods)];

  if (state.tomorrow.timePeriods.length) {
    lines.push("");
    lines.push(...formatPeriods("Завтра", state.tomorrow.timePeriods));
  }

  return lines;
}

function formatUpdatedAt(state) {
  return state.updatedAt ? ["", `🕒 ${escapeHtml(state.updatedAt)}`] : [];
}

function expandableQuote(lines) {
  return ["<blockquote expandable>", ...lines, "</blockquote>"];
}

function buildLightNotification(currentState, previousState = null, options = {}) {
  const lines = [
    `<b>${previousState ? "🔄 Змінився" : options.collapseSchedule ? "⚡ Актуальний" : "⚡ Новий"} графік · черга ${escapeHtml(currentState.queue)}.${escapeHtml(currentState.subQueue)}</b>`
  ];

  if (previousState) {
    if (options.changeSummary) {
      lines.push("", escapeHtml(options.changeSummary));
    }

    const details = [
      "<b>Було</b>",
      ...buildScheduleDetails(previousState),
      "",
      "<b>Тепер</b>",
      ...buildScheduleDetails(currentState)
    ];
    lines.push("", ...expandableQuote(details));
  } else {
    lines.push("");
    const details = buildScheduleDetails(currentState);
    lines.push(...(options.collapseSchedule ? expandableQuote(details) : details));
  }

  lines.push(...formatUpdatedAt(currentState));
  return lines.join("\n");
}

function buildDayLightNotification(currentState, previousDay, day, options = {}) {
  const dayLabel = day === "tomorrow" ? "Завтра" : "Сьогодні";
  const currentDay = currentState[day];
  const lines = [
    `<b>${previousDay ? "🔄 Змінився графік" : options.currentSchedule ? "⚡ Актуальний графік" : "📅 З’явився графік"} на ${dayLabel.toLowerCase()} · черга ${escapeHtml(currentState.queue)}.${escapeHtml(currentState.subQueue)}</b>`
  ];
  if (options.changeSummary) {
    lines.push("", escapeHtml(options.changeSummary));
  }
  const details = [];
  if (previousDay) {
    details.push("<b>Було</b>");
    details.push(...formatPeriods("", previousDay.timePeriods));
    details.push("");
    details.push("<b>Тепер</b>");
  }
  details.push(...formatPeriods(previousDay ? "" : dayLabel, currentDay.timePeriods));
  lines.push("", ...(previousDay ? expandableQuote(details) : details));
  lines.push(...formatUpdatedAt(currentState));
  return lines.join("\n");
}

function buildOutageReminderNotification(currentState, reminder) {
  const [headline, time] = formatOutageReminder(reminder);
  return [
    `<b>${headline} · черга ${escapeHtml(currentState.queue)}.${escapeHtml(currentState.subQueue)}</b>`,
    time,
    "",
    ...expandableQuote(buildScheduleDetails(currentState))
  ].join("\n");
}

module.exports = {
  buildOutageReminderNotification,
  buildScheduleDetails,
  buildLightNotification,
  buildDayLightNotification,
  escapeHtml,
  formatOutageReminder,
  formatPeriod
};
