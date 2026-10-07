"use strict";

const sharp = require("sharp");

const WIDTH = 1200;
const COLORS = { 1: "#2DBD68", 2: "#E34B52", 3: "#E8B934" };

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function clock(minute) {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function bars(day, blockStart, y) {
  const x = 142;
  const width = 1000;
  const blockEnd = blockStart + 360;
  const parts = [`<rect x="${x}" y="${y}" width="${width}" height="34" rx="8" fill="#293545"/>`];
  for (const period of day?.timePeriods || []) {
    const start = Math.max(blockStart, period.startMin);
    const end = Math.min(blockEnd, period.endMin);
    if (end <= start) continue;
    const left = x + (start - blockStart) * width / 360;
    const barWidth = (end - start) * width / 360;
    parts.push(`<rect x="${left}" y="${y}" width="${barWidth}" height="34" fill="${COLORS[period.status || period.state] || "#64748B"}"/>`);
    if ((period.status || period.state) === 2 && barWidth >= 70) {
      parts.push(`<text x="${left + barWidth / 2}" y="${y + 24}" text-anchor="middle" class="${barWidth < 125 ? "bar-label-small" : "bar-label"}">${clock(start)}–${clock(end)}</text>`);
    }
  }
  parts.push(`<rect x="${x}" y="${y}" width="${width}" height="34" rx="8" fill="none" stroke="#455469" stroke-width="2"/>`);
  return parts.join("");
}

async function renderScheduleImage({ queue, subQueue, day, previous, current, currentMinute }) {
  const compared = Boolean(previous?.timePeriods?.length);
  const both = day === "both";
  const height = both ? 1330 : compared ? 870 : 705;
  const title = `${both ? "Сьогодні і завтра" : day === "tomorrow" ? "Завтра" : "Сьогодні"} · черга ${queue}.${subQueue}`;
  const hasYellow = (both ? [current.today, current.tomorrow] : [current, previous])
    .some(item => item?.timePeriods?.some(period => (period.status || period.state) === 3));
  const blocks = [];
  for (let block = 0; block < (both ? 8 : 4); block += 1) {
    const tomorrowBlock = both && block >= 4;
    const localBlock = block % 4;
    const dayCurrent = both ? (tomorrowBlock ? current.tomorrow : current.today) : current;
    const localStart = localBlock * 360;
    const y = 145 + block * (compared ? 170 : 145);
    if (both && localBlock === 0) blocks.push(`<text x="60" y="${y - 20}" class="day-label">${tomorrowBlock ? "Завтра" : "Сьогодні"}</text>`);
    blocks.push(`<text x="60" y="${y + 3}" class="hours">${clock(localStart)}–${clock(localStart + 360)}</text>`);
    for (let hour = 0; hour <= 6; hour += 1) {
      const tickX = 142 + hour * 1000 / 6;
      blocks.push(`<text x="${tickX}" y="${y + 25}" text-anchor="middle" class="tick">${clock(localStart + hour * 60)}</text>`);
    }
    const firstY = y + 43;
    if (compared) {
      blocks.push(`<text x="60" y="${firstY + 24}" class="row-label">Було</text>`);
      blocks.push(bars(previous, localStart, firstY));
      blocks.push(`<text x="60" y="${firstY + 72}" class="row-label">Тепер</text>`);
      blocks.push(bars(dayCurrent, localStart, firstY + 48));
    } else {
      blocks.push(`<text x="60" y="${firstY + 24}" class="row-label">Графік</text>`);
      blocks.push(bars(dayCurrent, localStart, firstY));
    }
    if ((day === "today" || (both && !tomorrowBlock)) && currentMinute >= localStart && currentMinute < localStart + 360) {
      const markerX = 142 + (currentMinute - localStart) * 1000 / 360;
      const bottom = firstY + (compared ? 82 : 34);
      blocks.push(`<line x1="${markerX}" y1="${firstY - 4}" x2="${markerX}" y2="${bottom + 5}" stroke="#FFFFFF" stroke-width="3" stroke-dasharray="5 4"/>`);
      blocks.push(`<text x="${Math.max(175, markerX)}" y="${bottom + 26}" text-anchor="middle" class="now">зараз</text>`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">
    <style>text{font-family:DejaVu Sans,Noto Sans,Arial,sans-serif;fill:#F3F7FC}.title{font-size:38px;font-weight:700}.day-label{font-size:23px;font-weight:700}.hours{font-size:18px;font-weight:700}.tick{font-size:17px;fill:#D4DEEB}.row-label{font-size:19px;font-weight:700}.bar-label{font-size:17px;font-weight:700}.bar-label-small{font-size:12px;font-weight:700}.now{font-size:17px;font-weight:700}</style>
    <rect width="100%" height="100%" fill="#15202E"/>
    <text x="60" y="67" class="title">${escapeXml(title)}</text>
    <rect x="60" y="86" width="18" height="18" fill="${COLORS[1]}"/><text x="86" y="102" class="tick">Світло є</text>
    <rect x="260" y="86" width="18" height="18" fill="${COLORS[2]}"/><text x="286" y="102" class="tick">Світла немає</text>
    ${hasYellow ? `<rect x="525" y="86" width="18" height="18" fill="${COLORS[3]}"/><text x="551" y="102" class="tick">Можливе світло</text>` : ""}
    ${blocks.join("")}
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

module.exports = { renderScheduleImage };
