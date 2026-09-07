"use strict";

const { JSDOM } = require("jsdom");

const STATUS = Object.freeze({
  turnedOn: 1,
  turnedOff: 2,
  maybeTurnedOn: 3
});

const STATUS_LABELS = Object.freeze({
  [STATUS.turnedOn]: "світло є",
  [STATUS.turnedOff]: "світла немає",
  [STATUS.maybeTurnedOn]: "можливо є"
});

class PoeResponse {
  constructor(data) {
    this.$data = data;
    this.dom = new JSDOM(data);
  }

  get todayTable() {
    return this.getTable();
  }

  get tomorrowTable() {
    return this.getTable(1);
  }

  getTable(index = 0) {
    return this.dom.window.document.querySelectorAll("tbody")[index] || null;
  }

  get updatedAt() {
    const details = this.dom.window.document.querySelector(".gpvinfodetail");
    if (!details || !details.lastElementChild) {
      return null;
    }

    return details.lastElementChild.textContent.trim() || null;
  }
}

class Parser {
  constructor(table, queue = 0, subQueue = 0, options = {}) {
    this.queue = queue;
    this.subQueue = subQueue;
    this.now = options.now || new Date();
    const index = (this.queue - 1) * 2 + (this.subQueue - 1);
    this.table = table;
    const row = table ? table.querySelectorAll("tr")[index] : null;
    this.elements = row ? row.querySelectorAll("td") : [];
  }

  get segments() {
    const array = Array.from(this.elements)
      .slice(this.subQueue === 1 ? 2 : 1)
      .map((element) =>
        Number(
          [...element.classList].map((className) => className.match(/^light_(\d+)$/)).find(Boolean)?.[1]
        )
      );
    const result = [];
    let currentValue = array[0];
    let count = 0;

    array.forEach((value) => {
      if (value === currentValue) {
        count += 1;
      } else {
        result.push([currentValue, count]);
        currentValue = value;
        count = 1;
      }
    });

    if (currentValue) {
      result.push([currentValue, count]);
    }

    return result;
  }

  get timePeriods() {
    const result = [];
    let start = 0;

    this.segments.forEach(([value, count]) => {
      const end = start + count * 30;
      const startHour = Math.floor(start / 60).toString().padStart(2, "0");
      const startMinute = (start % 60).toString().padStart(2, "0");
      const endHour = Math.floor(end / 60).toString().padStart(2, "0");
      const endMinute = (end % 60).toString().padStart(2, "0");

      result.push({
        status: value,
        state: value,
        startMin: start,
        endMin: end,
        statusLabel: STATUS_LABELS[value] || "невідомо",
        time: `${startHour}:${startMinute} - ${endHour}:${endMinute}`,
        current: this.isCurrentPeriod([startHour, startMinute], [endHour, endMinute]),
        durationMinutes: count * 30
      });
      start = end;
    });

    return result;
  }

  get totalTimeOn() {
    return this.timePeriods
      .filter(({ status }) => [STATUS.turnedOn, STATUS.maybeTurnedOn].includes(status))
      .reduce((acc, { durationMinutes }) => acc + durationMinutes, 0);
  }

  get totalTimeOff() {
    return this.timePeriods
      .filter(({ status }) => status === STATUS.turnedOff)
      .reduce((acc, { durationMinutes }) => acc + durationMinutes, 0);
  }

  isCurrentPeriod(start, end) {
    const currentMinutes = this.now.getHours() * 60 + this.now.getMinutes();
    const times = [start, end].map((time) => {
      const [hour, minute] = time;
      return Number(hour) * 60 + Number(minute);
    });
    return currentMinutes >= times[0] && currentMinutes < times[1];
  }
}

function prettyTime(minutes) {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

function parseLightSchedule(html, queue, subQueue, options = {}) {
  const response = new PoeResponse(html);
  const todayParser = new Parser(response.todayTable, queue, subQueue, options);
  const tomorrowParser = new Parser(response.tomorrowTable, queue, subQueue, options);

  return {
    queue,
    subQueue,
    updatedAt: response.updatedAt,
    today: {
      timePeriods: todayParser.timePeriods,
      totalTimeOn: todayParser.totalTimeOn,
      totalTimeOff: todayParser.totalTimeOff
    },
    tomorrow: {
      timePeriods: tomorrowParser.timePeriods,
      totalTimeOn: tomorrowParser.totalTimeOn,
      totalTimeOff: tomorrowParser.totalTimeOff
    }
  };
}

module.exports = {
  Parser,
  PoeResponse,
  STATUS,
  STATUS_LABELS,
  parseLightSchedule,
  prettyTime
};
