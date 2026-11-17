"use strict";

// Experimental fast path for the current POE horizontal grid. It does not change the job.
const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const { PoeResponse, parseLightSchedule } = require("../src/jobs/light/parser");

const POE_URL = "https://www.poe.pl.ua/customs/dynamicgpv-info.php";
const TABLE = /<table\b[^>]*class="[^"]*\bgpv-table\b[^"]*"[^>]*>[\s\S]*?<\/table>/g;
const ROW = /<tr\b[^>]*>([\s\S]*?)<\/tr>/g;
const CELL = /<td\b([^>]*)>([\s\S]*?)<\/td>/g;

function sections(html) {
  const starts = [...html.matchAll(/<div\b[^>]*class="[^"]*\bgpvinfodetail\b[^"]*"[^>]*>/g)]
    .map(match => match.index);
  return starts.map((start, index) => html.slice(start, starts[index + 1] ?? html.length));
}

function extract(html) {
  const days = sections(html).map(section => {
    const table = section.match(TABLE)?.[0];
    if (!table) throw new Error("POE horizontal schedule table is missing");
    const body = /<tbody\b[^>]*>([\s\S]*?)<\/tbody>/.exec(table)?.[1];
    if (!body) throw new Error("POE horizontal schedule body is missing");
    const rows = [...body.matchAll(ROW)].map(([, row]) => {
      const cells = [...row.matchAll(CELL)];
      const queueKey = cells[0]?.[2].replace(/<[^>]*>/g, "").trim();
      const states = cells.slice(1).map(([, attributes]) => {
        const names = /\bclass="([^"]*)"/.exec(attributes)?.[1] || "";
        const status = /(?:^|\s)gpv-s([123])(?:\s|$)/.exec(names)?.[1];
        if (!status) throw new Error(`Missing status in queue ${queueKey}`);
        return Number(status);
      });
      if (!/^([1-6])\.([12])$/.test(queueKey) || states.length !== 48) {
        throw new Error(`Invalid POE schedule row ${queueKey}: ${states.length} periods`);
      }
      return { queueKey, states };
    });
    if (!rows.length || rows.length > 12 || new Set(rows.map(row => row.queueKey)).size !== rows.length) {
      throw new Error("Invalid POE schedule rows");
    }
    const updates = [...section.matchAll(/<div\b[^>]*>\s*(Оновлено:[^<]*)<\/div>/g)];
    const updatedAt = updates.at(-1)?.[1].trim();
    if (!updatedAt) throw new Error("POE publication time is missing");
    return { table, rows, updatedAt };
  });
  if (!days.length || days.length > 2) throw new Error(`Unexpected POE day count: ${days.length}`);
  return days;
}

function compactHtml(html) {
  return extract(html).map(day =>
    `<div class="gpvinfodetail">${day.table}<div>${day.updatedAt}</div></div>`
  ).join("");
}

function median(values) {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

function benchmark(operation, samples = 40) {
  for (let index = 0; index < 5; index += 1) operation();
  const cpu = [];
  for (let index = 0; index < samples; index += 1) {
    const start = process.cpuUsage();
    operation();
    const usage = process.cpuUsage(start);
    cpu.push((usage.user + usage.system) / 1000);
  }
  return Number(median(cpu).toFixed(3));
}

async function main() {
  const html = process.argv[2]
    ? await readFile(process.argv[2], "utf8")
    : await (await fetch(POE_URL, { headers: { "User-Agent": "alerts-tg-bot/1.0" } })).text();
  const days = extract(html);
  const compact = compactHtml(html);
  const fullResponse = new PoeResponse(html);
  const compactResponse = new PoeResponse(compact);
  const now = new Date("2026-11-17T17:00:00Z");
  const queueKeys = days[0].rows.map(row => row.queueKey);
  for (const key of queueKeys) {
    const [queue, subQueue] = key.split(".").map(Number);
    assert.deepEqual(parseLightSchedule(compactResponse, queue, subQueue, { now }),
      parseLightSchedule(fullResponse, queue, subQueue, { now }));
    for (let day = 0; day < days.length; day += 1) {
      const periods = (day ? "tomorrow" : "today");
      const schedule = parseLightSchedule(fullResponse, queue, subQueue, { now })[periods];
      const expected = schedule.timePeriods.flatMap(period =>
        Array(period.durationMinutes / 30).fill(period.status));
      assert.deepEqual(days[day].rows.find(row => row.queueKey === key)?.states, expected);
    }
  }
  const firstThree = queueKeys.slice(0, 3);
  const parseThree = source => {
    const response = new PoeResponse(source);
    for (const key of firstThree) {
      const [queue, subQueue] = key.split(".").map(Number);
      parseLightSchedule(response, queue, subQueue, { now });
    }
  };
  console.log(JSON.stringify({
    sourceChars: html.length,
    compactChars: compact.length,
    days: days.length,
    queuesCompared: queueKeys.length,
    medianCpuMs: {
      fullTree: benchmark(() => parseThree(html)),
      tableTree: benchmark(() => parseThree(compact)),
      statusScan: benchmark(() => extract(html), 100)
    }
  }, null, 2));
}

if (require.main === module) main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

module.exports = { extract, compactHtml };
