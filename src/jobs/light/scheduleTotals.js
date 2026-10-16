"use strict";

function dayTotals(periods) {
  const totals = { 1: 0, 2: 0, 3: 0 };
  for (const period of periods || []) {
    const status = period.status || period.state;
    if (!(status in totals)) continue;
    const minutes = Number.isFinite(period.durationMinutes)
      ? period.durationMinutes : period.endMin - period.startMin;
    if (Number.isFinite(minutes) && minutes > 0) totals[status] += minutes;
  }
  return totals;
}

function durationClock(minutes) {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

module.exports = { dayTotals, durationClock };
