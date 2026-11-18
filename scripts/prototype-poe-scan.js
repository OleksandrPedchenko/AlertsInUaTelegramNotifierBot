"use strict";

// Compare the production fast path with the existing DOM fallback.
const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const { PoeResponse, parseLightSchedule } = require("../src/jobs/light/parser");
const { scanPoeSchedule } = require("../src/jobs/light/poeFastScan");

const POE_URL = "https://www.poe.pl.ua/customs/dynamicgpv-info.php";

function extract(html) {
  const result = scanPoeSchedule(html);
  if (!result) throw new Error("POE fast scan rejected this layout");
  return result.days;
}

function compactHtml(html) {
  return extract(html).map(day =>
    `<div class="gpvinfodetail">${day.tableHtml}<div>${day.updatedAt}</div></div>`
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
  const fallbackFull = html.replaceAll('class="gpvinfodetail"', "class='gpvinfodetail'");
  const fallbackCompact = compact.replaceAll('class="gpvinfodetail"', "class='gpvinfodetail'");
  const fullResponse = new PoeResponse(html);
  const compactResponse = new PoeResponse(compact);
  const fallbackResponse = new PoeResponse(fallbackFull);
  assert.equal(fallbackResponse.fastScan, null);
  const now = new Date("2026-11-17T17:00:00Z");
  const queueKeys = days[0].rows.map(row => row.queueKey);
  for (const key of queueKeys) {
    const [queue, subQueue] = key.split(".").map(Number);
    assert.deepEqual(parseLightSchedule(compactResponse, queue, subQueue, { now }),
      parseLightSchedule(fallbackResponse, queue, subQueue, { now }));
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
      fullTree: benchmark(() => parseThree(fallbackFull)),
      tableTree: benchmark(() => parseThree(fallbackCompact)),
      fastSchedule: benchmark(() => parseThree(html)),
      statusScan: benchmark(() => extract(html), 100)
    }
  }, null, 2));
}

if (require.main === module) main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

module.exports = { extract, compactHtml };
