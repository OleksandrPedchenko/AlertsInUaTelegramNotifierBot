"use strict";

const TABLE = /<table\b[^>]*class="[^"]*\bgpv-table\b[^"]*"[^>]*>[\s\S]*?<\/table>/g;
const ROW = /<tr\b[^>]*>([\s\S]*?)<\/tr>/g;
const CELL = /<td\b([^>]*)>([\s\S]*?)<\/td>/g;

function scan(html) {
  const starts = [...html.matchAll(/<div\b[^>]*class="[^"]*\bgpvinfodetail\b[^"]*"[^>]*>/g)]
    .map(match => match.index);
  if (!starts.length || starts.length > 2) throw new Error("Unexpected POE day count");
  const days = starts.map((start, index) => {
    const section = html.slice(start, starts[index + 1] ?? html.length);
    const tableHtml = section.match(TABLE)?.[0];
    if (!tableHtml) throw new Error("POE horizontal schedule table is missing");
    const body = /<tbody\b[^>]*>([\s\S]*?)<\/tbody>/.exec(tableHtml)?.[1];
    if (!body) throw new Error("POE horizontal schedule body is missing");
    const rows = [...body.matchAll(ROW)].map(([, row], rowIndex) => {
      const cells = [...row.matchAll(CELL)];
      const queueKey = cells[0]?.[2].replace(/<[^>]*>/g, "").trim();
      const expectedKey = `${Math.floor(rowIndex / 2) + 1}.${rowIndex % 2 + 1}`;
      if (queueKey !== expectedKey || cells.length !== 49) throw new Error("Invalid POE queue row");
      const states = cells.slice(1).map(([, attributes]) => {
        const names = /\bclass="([^"]*)"/.exec(attributes)?.[1] || "";
        const status = /(?:^|\s)gpv-s([123])(?:\s|$)/.exec(names)?.[1];
        if (!status) throw new Error("Missing POE schedule status");
        return Number(status);
      });
      return { queueKey, states };
    });
    if (!rows.length || rows.length > 12) throw new Error("Invalid POE schedule rows");
    const updates = [...section.matchAll(/<div\b[^>]*>\s*(Оновлено:[^<]*)<\/div>/g)];
    const updatedAt = updates.at(-1)?.[1].trim();
    if (!updatedAt || updatedAt.includes("&")) throw new Error("POE publication time is missing");
    return { tableHtml, rows, updatedAt };
  });
  if (days.length === 2 && days[1].rows.length !== days[0].rows.length) {
    throw new Error("POE days have different queues");
  }
  return { days };
}

function scanPoeSchedule(html) {
  try {
    return scan(html);
  } catch {
    return null;
  }
}

module.exports = { scanPoeSchedule };
