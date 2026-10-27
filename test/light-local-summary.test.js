"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { describeLocalScheduleChange } = require("../src/jobs/light/localSummary");

function day(states) {
  const periods = [];
  states.forEach((state, index) => {
    const previous = periods.at(-1);
    if (previous?.state === state) previous.endMin += 30;
    else periods.push({ state, startMin: index * 30, endMin: (index + 1) * 30 });
  });
  return { timePeriods: periods };
}

function schedule(outages, yellow = []) {
  const states = Array(48).fill(1);
  for (const [start, end] of outages) states.fill(2, start / 30, end / 30);
  for (const [start, end] of yellow) states.fill(3, start / 30, end / 30);
  return day(states);
}

test("local summary reports full intervals for a current outage extension", () => {
  const old = schedule([[900, 960]]);
  const now = schedule([[900, 990]]);
  assert.equal(describeLocalScheduleChange(old, now, 970, true),
    "🔴 Відключення продовжено на 30 хвилин: 15:00–16:30 (було 15:00–16:00).");
  assert.equal(describeLocalScheduleChange(old, now, 990, true), "");
});

test("local summary inflects whole-hour durations", () => {
  const old = schedule([[0, 30]]);
  for (const [minutes, duration] of [
    [60, "1 годину"], [120, "2 години"], [300, "5 годин"],
    [660, "11 годин"], [1260, "21 годину"]
  ]) {
    const now = schedule([[0, 30 + minutes]]);
    assert.match(describeLocalScheduleChange(old, now, null, true),
      new RegExp(`Відключення продовжено на ${duration}:`));
  }
});

test("local summary handles shortened outage and tentative return", () => {
  const old = schedule([[960, 1020]]);
  const now = schedule([[960, 990]], [[990, 1020]]);
  assert.equal(describeLocalScheduleChange(old, now, null, false),
    "🟡 Відключення скорочено на 30 хвилин: 16:00–16:30 (було 16:00–17:00). Світло може з’явитися раніше.");
  assert.equal(describeLocalScheduleChange(old, now, null, true),
    "🟢 Відключення скорочено на 30 хвилин: 16:00–16:30 (було 16:00–17:00).");
});

test("local summary distinguishes confirmed and tentative cancellation", () => {
  const old = schedule([[960, 1020]]);
  assert.equal(describeLocalScheduleChange(old, schedule([]), null, false),
    "🟢 Скасовано відключення: 16:00–17:00.");
  assert.equal(describeLocalScheduleChange(old, schedule([], [[960, 1020]]), null, false),
    "🟡 Відключення 16:00–17:00 прибрано з графіка. Світло може з’явитися раніше.");
});

test("local summary reports additions, removals and multiple outages chronologically", () => {
  const old = schedule([[60, 120], [600, 660]]);
  const now = schedule([[60, 150], [900, 960]]);
  const lines = describeLocalScheduleChange(old, now, null, true).split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /01:00–02:30 \(було 01:00–02:00\)/);
  assert.match(lines[1], /10:00–11:00/);
  assert.match(lines[2], /15:00–16:00/);
});

test("local summary never describes a strict yellow-only revision as an outage", () => {
  const old = schedule([[60, 90]], [[90, 120]]);
  const now = schedule([[60, 90]]);
  assert.equal(describeLocalScheduleChange(old, now, null, false), "");
});

test("local summary describes shifted outages without claiming an extension", () => {
  const old = schedule([[600, 660]]);
  const now = schedule([[630, 690]]);
  const summary = describeLocalScheduleChange(old, now, null, true);
  assert.equal(summary, "🔄 Час відключення змінено: 10:30–11:30 (було 10:00–11:00).");
  assert.doesNotMatch(summary, /продовжено|скорочено/);
});

test("local summary keeps 24:00 and ignores reordered but equivalent periods", () => {
  const old = schedule([[1410, 1440]]);
  const now = schedule([[1380, 1440]]);
  assert.match(describeLocalScheduleChange(old, now, null, true), /23:00–24:00/);
  assert.equal(describeLocalScheduleChange(now, { timePeriods: [...now.timePeriods].reverse() }, null, true), "");
});

test("local summary describes a split without inventing a simple shortening", () => {
  const old = schedule([[600, 720]]);
  const now = schedule([[600, 630], [660, 720]]);
  const summary = describeLocalScheduleChange(old, now, null, true);
  assert.equal(summary, "🔄 Графік відключень змінено: було 10:00–12:00; тепер 10:00–10:30, 11:00–12:00.");
  assert.doesNotMatch(summary, /скорочено/);
});

test("local summary rejects overlapping periods instead of guessing", () => {
  const invalid = { timePeriods: [
    { state: 1, startMin: 0, endMin: 60 },
    { state: 2, startMin: 30, endMin: 90 }
  ] };
  assert.throws(() => describeLocalScheduleChange(invalid, schedule([]), null, true),
    /Overlapping POE schedule periods/);
});

test("local summary rejects a partial day instead of treating missing cells as light on", () => {
  assert.throws(() => describeLocalScheduleChange(day([1, 2]), schedule([]), null, true),
    /Incomplete POE schedule/);
});
