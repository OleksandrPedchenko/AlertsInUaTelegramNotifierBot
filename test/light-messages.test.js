"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildDayLightNotification,
  buildLightNotification,
  buildOutageReminderNotification
} = require("../src/jobs/light/messageCatalog");

const periods = [
  { time: "00:00 - 17:00", status: 1, statusLabel: "світло є", current: true, durationMinutes: 1020 },
  { time: "17:00 - 18:00", status: 2, statusLabel: "світла немає", durationMinutes: 60 },
  { time: "18:00 - 24:00", status: 3, statusLabel: "можливо є", durationMinutes: 360 }
];
const day = { timePeriods: periods, totalTimeOn: 1380, totalTimeOff: 60 };
const state = {
  queue: 5, subQueue: 1, today: day, tomorrow: day,
  updatedAt: "Оновлено о 12:00", sourceUrl: "https://example.test/poe"
};

test("new schedules show colored full periods without source or quote", () => {
  const initial = buildLightNotification(state);
  const tomorrow = buildDayLightNotification(state, null, "tomorrow");
  for (const message of [initial, tomorrow]) {
    assert.match(message, /🟢 00:00–17:00/);
    assert.match(message, /🔴 17:00–18:00/);
    assert.match(message, /🟡 18:00–24:00/);
    assert.doesNotMatch(message, /Джерело|example\.test|blockquote|Разом:/);
  }
  assert.match(tomorrow, /З’явився графік на завтра/);
  assert.doesNotMatch(initial, /Зараз:/);
});

test("a forced repeat keeps the full schedule in an expandable quote", () => {
  const message = buildLightNotification(state, null, { collapseSchedule: true });
  assert.match(message, /Актуальний графік/);
  assert.match(message, /<blockquote expandable>[^]*Сьогодні[^]*Завтра[^]*<\/blockquote>/);
});

test("revisions keep the summary visible and always quote the full old and new day", () => {
  const withSummary = buildDayLightNotification(state, day, "today", { changeSummary: "Відключення змінилось." });
  const withoutSummary = buildDayLightNotification(state, day, "today");
  for (const message of [withSummary, withoutSummary]) {
    assert.match(message, /🔄 Змінився графік на сьогодні/);
    assert.match(message, /<blockquote expandable>[^]*Було[^]*🟢 00:00–17:00[^]*Тепер[^]*🔴 17:00–18:00[^]*<\/blockquote>/);
    assert.doesNotMatch(message, /Джерело|example\.test|Разом:/);
  }
  assert.ok(withSummary.indexOf("Відключення змінилось.") < withSummary.indexOf("<blockquote expandable>"));
});

test("reminders lead with colored action and quote the full schedule", () => {
  for (const [kind, tentative, headline] of [
    ["off", false, /🔴 Відключення через 10 хв/],
    ["on", false, /🟢 Світло з’явиться через 10 хв/],
    ["on", true, /🟡 Світло може з’явитися через 10 хв/]
  ]) {
    const message = buildOutageReminderNotification(state, {
      kind, tentative, day: "today", time: "17:00 - 18:00", minutesUntilStart: 10
    });
    assert.match(message, headline);
    assert.match(message, /<blockquote expandable>[^]*Сьогодні[^]*🔴 17:00–18:00[^]*Завтра[^]*<\/blockquote>/);
    assert.doesNotMatch(message, /Джерело|example\.test/);
  }
});
