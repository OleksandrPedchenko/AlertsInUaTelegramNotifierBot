"use strict";

const sharp = require("sharp");

const WIDTH = 1000;
const BAR_X = 130;
const BAR_WIDTH = 820;
const COLORS = { 1: "#2DBD68", 2: "#E34B52", 3: "#E8B934" };

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function clock(minute) {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function shortDate(scheduleDate, offset) {
  if (!scheduleDate) return "";
  const date = new Date(`${scheduleDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() + offset);
  return ` · ${String(date.getUTCDate()).padStart(2, "0")}.${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function outageDuration(minutes) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return [hours ? `${hours} год` : "", rest ? `${rest} хв` : ""].filter(Boolean).join(" ");
}

function drawOutages(day, y) {
  const outages = (day?.timePeriods || []).filter(period => (period.status || period.state) === 2);
  if (!outages.length) {
    return {
      svg: `<rect x="48" y="${y}" width="904" height="50" rx="12" fill="#213D36"/>
        <text x="68" y="${y + 32}" class="empty">Відключень не заплановано</text>`,
      rows: 1
    };
  }
  const cards = outages.map((period, index) => {
    const x = 48 + (index % 2) * 460;
    const top = y + Math.floor(index / 2) * 60;
    return `<rect x="${x}" y="${top}" width="444" height="50" rx="12" fill="#303440"/>
      <rect x="${x}" y="${top}" width="7" height="50" rx="3" fill="${COLORS[2]}"/>
      <text x="${x + 20}" y="${top + 33}" class="outage">${clock(period.startMin)}–${clock(period.endMin)}</text>
      <text x="${x + 428}" y="${top + 31}" text-anchor="end" class="duration">${outageDuration(period.endMin - period.startMin)}</text>`;
  });
  return { svg: cards.join(""), rows: Math.ceil(outages.length / 2) };
}

function drawBar(day, halfStart, y) {
  const shapes = [`<rect x="${BAR_X}" y="${y}" width="${BAR_WIDTH}" height="25" rx="7" fill="#455266"/>`];
  for (const period of day?.timePeriods || []) {
    const start = Math.max(halfStart, period.startMin);
    const end = Math.min(halfStart + 720, period.endMin);
    if (end <= start) continue;
    const x = BAR_X + (start - halfStart) * BAR_WIDTH / 720;
    const width = (end - start) * BAR_WIDTH / 720;
    shapes.push(`<rect x="${x}" y="${y}" width="${width}" height="25" fill="${COLORS[period.status || period.state] || "#64748B"}"/>`);
  }
  shapes.push(`<rect x="${BAR_X}" y="${y}" width="${BAR_WIDTH}" height="25" rx="7" fill="none" stroke="#56677E" stroke-width="2"/>`);
  return shapes.join("");
}

function drawTimelines(day, previous, y) {
  const compared = Boolean(previous?.timePeriods?.length);
  const lines = [];
  for (let half = 0; half < 2; half += 1) {
    const halfStart = half * 720;
    const top = y + half * (compared ? 112 : 86);
    lines.push(`<text x="48" y="${top + 15}" class="half">${half ? "12–24" : "00–12"}</text>`);
    for (let tick = 0; tick <= 6; tick += 1) {
      const x = BAR_X + tick * BAR_WIDTH / 6;
      lines.push(`<text x="${x}" y="${top + 15}" text-anchor="middle" class="tick">${clock(halfStart + tick * 120)}</text>`);
    }
    const firstBarY = top + 26;
    if (compared) {
      lines.push(`<text x="48" y="${firstBarY + 19}" class="row">Було</text>`);
      lines.push(drawBar(previous, halfStart, firstBarY));
      lines.push(`<text x="48" y="${firstBarY + 57}" class="row">Тепер</text>`);
      lines.push(drawBar(day, halfStart, firstBarY + 38));
    } else {
      lines.push(drawBar(day, halfStart, firstBarY));
    }
  }
  return { svg: lines.join(""), height: compared ? 224 : 172 };
}

function drawDay(day, label, date, previous, y, isToday) {
  const parts = [`<text x="48" y="${y + 29}" class="day">${label}${shortDate(date, isToday ? 0 : 1)}</text>`];
  const chipsY = y + 52;
  const outages = drawOutages(day, chipsY);
  parts.push(outages.svg);
  const timelineY = chipsY + outages.rows * 60 + 15;
  const timeline = drawTimelines(day, previous, timelineY);
  parts.push(timeline.svg);
  return { svg: parts.join(""), nextY: timelineY + timeline.height + 18 };
}

async function renderScheduleImage({ queue, subQueue, day, previous, current, scheduleDate }) {
  const sections = [{ day: current, label: day === "tomorrow" ? "Завтра" : "Сьогодні", previous, isToday: day !== "tomorrow" }];
  let y = 88;
  const content = [];
  for (const section of sections) {
    const drawn = drawDay(section.day, section.label, scheduleDate, section.previous, y, section.isToday);
    content.push(drawn.svg);
    y = drawn.nextY;
  }
  const hasYellow = sections.some(section =>
    [section.day, section.previous].some(item => item?.timePeriods?.some(period => (period.status || period.state) === 3))
  );
  const legend = hasYellow ? `<rect x="48" y="${y}" width="17" height="17" fill="${COLORS[3]}"/>
    <text x="75" y="${y + 15}" class="legend">Жовтий — можливе світло</text>` : "";
  const height = Math.ceil(y + (hasYellow ? 48 : 20));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">
    <style>text{font-family:DejaVu Sans,Noto Sans,Arial,sans-serif;fill:#F3F7FC}.title{font-size:36px;font-weight:700}.day{font-size:26px;font-weight:700}.outage{font-size:25px;font-weight:700}.duration{font-size:17px;fill:#E6C5C7}.empty{font-size:22px;font-weight:700;fill:#BDEAD0}.half{font-size:18px;font-weight:700}.tick{font-size:16px;fill:#C3CFDE}.row{font-size:17px;font-weight:700}.legend{font-size:17px;fill:#C3CFDE}</style>
    <rect width="100%" height="100%" fill="#15202E"/>
    <text x="48" y="60" class="title">Черга ${escapeXml(queue)}.${escapeXml(subQueue)}</text>
    ${content.join("")}${legend}
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

module.exports = { renderScheduleImage };
