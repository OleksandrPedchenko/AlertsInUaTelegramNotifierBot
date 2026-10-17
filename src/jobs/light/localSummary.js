"use strict";

const { parsePeriodMinutes } = require("./geminiClient");

function scheduleSlots(day, treatYellowAsGreen = false) {
  const slots = Array(48).fill(null);
  for (const period of day?.timePeriods || []) {
    const { startMin, endMin } = parsePeriodMinutes(period);
    const rawState = period.state || period.status;
    const state = treatYellowAsGreen && rawState === 3 ? 1 : rawState;
    if (!Number.isInteger(startMin) || !Number.isInteger(endMin) ||
        startMin < 0 || endMin > 1440 || startMin >= endMin ||
        startMin % 30 || endMin % 30 || ![1, 2, 3].includes(state)) {
      throw new Error("Invalid POE schedule period");
    }
    for (let slot = startMin / 30; slot < endMin / 30; slot++) {
      if (slots[slot] !== null) throw new Error("Overlapping POE schedule periods");
      slots[slot] = state;
    }
  }
  if (slots.includes(null)) throw new Error("Incomplete POE schedule");
  return slots;
}

function outageIntervals(slots) {
  const intervals = [];
  for (let slot = 0; slot < 48; slot++) {
    if (slots[slot] !== 2) continue;
    const startMin = slot * 30;
    while (slot + 1 < 48 && slots[slot + 1] === 2) slot++;
    intervals.push({ startMin, endMin: (slot + 1) * 30 });
  }
  return intervals;
}

function formatMinute(minute) {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function formatInterval({ startMin, endMin }) {
  return `${formatMinute(startMin)}–${formatMinute(endMin)}`;
}

function formatDuration(minutes) {
  return minutes % 60 === 0 ? `${minutes / 60} год` : `${minutes} хв`;
}

function describeLocalScheduleChange(previousDay, currentDay, currentMinute, treatYellowAsGreen) {
  const oldSlots = scheduleSlots(previousDay, treatYellowAsGreen);
  const newSlots = scheduleSlots(currentDay, treatYellowAsGreen);
  const intervals = [
    ...outageIntervals(oldSlots).map(interval => ({ ...interval, old: true })),
    ...outageIntervals(newSlots).map(interval => ({ ...interval, old: false }))
  ];
  const visited = new Set();
  const lines = [];
  for (let index = 0; index < intervals.length; index++) {
    if (visited.has(index)) continue;
    const component = [];
    const pending = [index];
    visited.add(index);
    while (pending.length) {
      const member = intervals[pending.pop()];
      component.push(member);
      intervals.forEach((other, otherIndex) => {
        if (!visited.has(otherIndex) && member.old !== other.old &&
            member.startMin < other.endMin && other.startMin < member.endMin) {
          visited.add(otherIndex);
          pending.push(otherIndex);
        }
      });
    }
    const start = Math.min(...component.map(interval => interval.startMin));
    const end = Math.max(...component.map(interval => interval.endMin));
    const relevant = Array.from({ length: (end - start) / 30 }, (_, offset) => start / 30 + offset)
      .some(slot => (slot + 1) * 30 > (Number.isInteger(currentMinute) ? currentMinute : -1) &&
        (oldSlots[slot] === 2) !== (newSlots[slot] === 2));
    if (!relevant) continue;

    const old = component.filter(interval => interval.old).sort((a, b) => a.startMin - b.startMin);
    const now = component.filter(interval => !interval.old).sort((a, b) => a.startMin - b.startMin);
    let text;
    if (!old.length) {
      text = `🔴 Додано відключення: ${formatInterval(now[0])}.`;
    } else if (!now.length) {
      const tentative = old.some(interval => Array.from({ length: (interval.endMin - interval.startMin) / 30 },
        (_, offset) => newSlots[interval.startMin / 30 + offset]).includes(3));
      text = `${tentative ? "🟡" : "🟢"} Відключення скасовано: ${formatInterval(old[0])}.`;
      if (tentative) text += " Світло може з’явитися раніше.";
    } else if (old.length === 1 && now.length === 1) {
      const before = old[0];
      const after = now[0];
      const oldLength = before.endMin - before.startMin;
      const newLength = after.endMin - after.startMin;
      const aligned = before.startMin === after.startMin || before.endMin === after.endMin;
      if (aligned && newLength > oldLength) {
        text = `🔴 Відключення продовжено: ${formatInterval(after)} (було ${formatInterval(before)}) — на ${formatDuration(newLength - oldLength)} довше.`;
      } else if (aligned && newLength < oldLength) {
        const tentative = Array.from({ length: (end - start) / 30 }, (_, offset) => start / 30 + offset)
          .some(slot => oldSlots[slot] === 2 && newSlots[slot] === 3);
        text = `${tentative ? "🟡" : "🟢"} Відключення скорочено: ${formatInterval(after)} (було ${formatInterval(before)}) — на ${formatDuration(oldLength - newLength)} коротше.`;
        if (tentative) text += " Світло може з’явитися раніше.";
      } else {
        text = `🔄 Відключення змінено: ${formatInterval(after)} (було ${formatInterval(before)}).`;
      }
    } else {
      text = `🔄 Відключення змінено: було ${old.map(formatInterval).join(", ") || "немає"}; тепер ${now.map(formatInterval).join(", ") || "немає"}.`;
    }
    lines.push({ start, text });
  }
  return lines.sort((a, b) => a.start - b.start).map(line => line.text).join("\n");
}

module.exports = { describeLocalScheduleChange, scheduleSlots };
