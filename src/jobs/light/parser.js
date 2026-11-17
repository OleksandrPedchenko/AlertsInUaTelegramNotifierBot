"use strict";

const { parse } = require("parse5");

const children = node => node?.childNodes || [];
const classes = node => node?.attrs?.find(attribute => attribute.name === "class")?.value.split(/\s+/) || [];

function descendants(node, predicate) {
  const matches = [];
  for (const child of children(node)) {
    if (predicate(child)) matches.push(child);
    matches.push(...descendants(child, predicate));
  }
  return matches;
}

function closest(node, predicate) {
  for (let current = node; current; current = current.parentNode) {
    if (predicate(current)) return current;
  }
  return null;
}

function textContent(node) {
  return node?.nodeName === "#text" ? node.value : children(node).map(textContent).join("");
}

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
    this.dom = parse(data);
    this.tables = descendants(this.dom, node => node.tagName === "tbody")
      .filter(body => !closest(body, node => node.tagName === "table" && classes(node).includes("gpv-vtable")));
  }

  get todayTable() {
    return this.getTable();
  }

  get tomorrowTable() {
    return this.getTable(1);
  }

  getTable(index = 0) {
    return this.tables[index] || null;
  }

  get updatedAt() {
    const details = descendants(this.dom, node => classes(node).includes("gpvinfodetail"))[0];
    return this.updatedAtIn(details);
  }

  updatedAtForTable(table) {
    return this.updatedAtIn(closest(table, node => classes(node).includes("gpvinfodetail"))) || this.updatedAt;
  }

  updatedAtIn(details) {
    const lastElement = children(details).filter(node => node.tagName).at(-1);
    if (!lastElement) {
      return null;
    }

    return textContent(lastElement).trim() || null;
  }
}

class Parser {
  constructor(table, queue = 0, subQueue = 0, options = {}) {
    this.queue = queue;
    this.subQueue = subQueue;
    this.now = options.now || new Date();
    const index = (this.queue - 1) * 2 + (this.subQueue - 1);
    this.table = table;
    const row = table ? descendants(table, node => node.tagName === "tr")[index] : null;
    this.elements = row ? descendants(row, node => node.tagName === "td") : [];
  }

  get segments() {
    const labelCells = closest(this.table, node => node.tagName === "table" && classes(node).includes("gpv-table"))
      ? 1 : (this.subQueue === 1 ? 2 : 1);
    const array = Array.from(this.elements)
      .slice(labelCells)
      .map((element) =>
        Number(
          classes(element).map((className) => className.match(/^(?:light_|gpv-s)([123])$/)).find(Boolean)?.[1]
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

function hasExplicitNoScheduleNotice(response) {
  if (response.todayTable) return false;
  const body = descendants(response.dom, node => node.tagName === "body")[0];
  const text = textContent(body).replace(/\s+/g, " ").toLowerCase();
  return /(?:гпв|графік|відключенн)/u.test(text) &&
    /(?:не\s+(?:запланован|запроваджен|застосов|передбачен)\w*|відсутн\w*|немає)/u.test(text);
}

function allDayLight() {
  return {
    timePeriods: [{
      status: STATUS.turnedOn,
      state: STATUS.turnedOn,
      startMin: 0,
      endMin: 1440,
      statusLabel: STATUS_LABELS[STATUS.turnedOn],
      time: "00:00 - 24:00",
      current: true,
      durationMinutes: 1440
    }],
    totalTimeOn: 1440,
    totalTimeOff: 0
  };
}

function parseLightSchedule(html, queue, subQueue, options = {}) {
  const response = html instanceof PoeResponse ? html : new PoeResponse(html);
  const todayParser = new Parser(response.todayTable, queue, subQueue, options);
  const tomorrowParser = new Parser(response.tomorrowTable, queue, subQueue, options);

  const hasSchedule = todayParser.elements.some((cell) =>
    classes(cell).some((name) => /^(?:light_|gpv-s)[123]$/.test(name))
  );
  if (!hasSchedule) {
    if (hasExplicitNoScheduleNotice(response)) {
      return {
        queue, subQueue, updatedAt: response.updatedAt, noScheduleToday: true,
        today: allDayLight(),
        tomorrow: { timePeriods: [], totalTimeOn: 0, totalTimeOff: 0 }
      };
    }
    throw new Error(`POE schedule row ${queue}.${subQueue} is missing or invalid`);
  }

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
      updatedAt: response.updatedAtForTable(response.tomorrowTable),
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
