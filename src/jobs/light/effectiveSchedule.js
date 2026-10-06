"use strict";

function effectiveDay(day, treatYellowAsGreen) {
  if (!treatYellowAsGreen || !Array.isArray(day?.timePeriods)) return day;

  const timePeriods = [];
  for (const period of day.timePeriods) {
    const green = (period.state || period.status) === 3;
    const next = green
      ? { ...period, state: 1, status: 1, statusLabel: "світло є" }
      : { ...period };
    const previous = timePeriods.at(-1);
    if (previous?.status === next.status && Number.isInteger(previous.endMin) &&
        previous.endMin === next.startMin) {
      previous.endMin = next.endMin;
      previous.durationMinutes = previous.endMin - previous.startMin;
      previous.time = `${previous.time.split(" - ")[0]} - ${next.time.split(" - ")[1]}`;
      previous.current = Boolean(previous.current || next.current);
    } else {
      timePeriods.push(next);
    }
  }
  return { ...day, timePeriods };
}

function effectiveSchedule(state, treatYellowAsGreen) {
  if (!treatYellowAsGreen) return state;
  return {
    ...state,
    today: effectiveDay(state.today, true),
    tomorrow: effectiveDay(state.tomorrow, true)
  };
}

module.exports = { effectiveDay, effectiveSchedule };
