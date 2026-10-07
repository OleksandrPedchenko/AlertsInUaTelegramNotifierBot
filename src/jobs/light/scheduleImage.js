"use strict";

const sharp = require("sharp");
const { dayTotals, durationClock } = require("./scheduleTotals");

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

function drawTotals(day, y) {
  const totals = dayTotals(day?.timePeriods);
  const values = [
    { x: 245, color: COLORS[1], text: `+${durationClock(totals[1])}` },
    { x: 500, color: COLORS[2], text: `−${durationClock(totals[2])}` },
    ...(totals[3] ? [{ x: 755, color: COLORS[3], text: durationClock(totals[3]) }] : [])
  ];
  return `<text x="48" y="${y}" class="summary-label">За добу</text>${values.map(value =>
    `<circle cx="${value.x}" cy="${y - 8}" r="10" fill="${value.color}"/>` +
    `<text x="${value.x + 22}" y="${y}" class="summary">${value.text}</text>`
  ).join("")}`;
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
  for (let tick = 1; tick < 24; tick += 1) {
    const x = BAR_X + tick * BAR_WIDTH / 24;
    const lineWidth = tick % 12 === 0 ? 5 : tick % 4 === 0 ? 4 : tick % 2 === 0 ? 3 : 2;
    const opacity = tick % 12 === 0 ? 0.9 : tick % 4 === 0 ? 0.75 : tick % 2 === 0 ? 0.6 : 0.45;
    shapes.push(`<rect x="${x - lineWidth / 2}" y="${y}" width="${lineWidth}" height="25" fill="#DCE6F1" opacity="${opacity}"/>`);
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
  const totalsY = chipsY + outages.rows * 60 + 18;
  parts.push(drawTotals(day, totalsY));
  const timelineY = totalsY + 24;
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
    <style>text{font-family:DejaVu Sans,Noto Sans,Arial,sans-serif;fill:#F3F7FC}.title{font-size:36px;font-weight:700}.day{font-size:26px;font-weight:700}.outage{font-size:25px;font-weight:700}.duration{font-size:17px;fill:#E6C5C7}.empty{font-size:22px;font-weight:700;fill:#BDEAD0}.summary-label{font-size:21px;fill:#C3CFDE}.summary{font-size:25px;font-weight:700}.half{font-size:18px;font-weight:700}.tick{font-size:16px;fill:#C3CFDE}.row{font-size:17px;font-weight:700}.legend{font-size:17px;fill:#C3CFDE}</style>
    <rect width="100%" height="100%" fill="#15202E"/>
    <text x="48" y="60" class="title">Черга ${escapeXml(queue)}.${escapeXml(subQueue)}</text>
    ${content.join("")}${legend}
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function verticalStatus(day, minute) {
  const period = day?.timePeriods?.find(item => item.startMin <= minute && minute < item.endMin);
  return COLORS[period?.status || period?.state] || "#64748B";
}

function verticalPanel(current, previous, startMinute, x, y) {
  const compared = Boolean(previous?.timePeriods?.length);
  const rowHeight = 26;
  const barY = y + 48;
  const bars = compared
    ? [{ day: previous, x: x + 92, width: 154 }, { day: current, x: x + 260, width: 154 }]
    : [{ day: current, x: x + 92, width: 322 }];
  const parts = [
    `<text x="${x}" y="${y + 25}" class="half">${clock(startMinute)}–${clock(startMinute + 720)}</text>`
  ];
  if (compared) {
    parts.push(`<text x="${bars[0].x + bars[0].width / 2}" y="${y + 25}" text-anchor="middle" class="row">Було</text>`);
    parts.push(`<text x="${bars[1].x + bars[1].width / 2}" y="${y + 25}" text-anchor="middle" class="row">Тепер</text>`);
  } else {
    parts.push(`<text x="${bars[0].x + bars[0].width / 2}" y="${y + 25}" text-anchor="middle" class="row">Світло</text>`);
  }
  for (let cell = 0; cell < 24; cell += 1) {
    const minute = startMinute + cell * 30;
    const top = barY + cell * rowHeight;
    for (const bar of bars) {
      parts.push(`<rect x="${bar.x}" y="${top + 1}" width="${bar.width}" height="${rowHeight - 1}" fill="${verticalStatus(bar.day, minute + 15)}"/>`);
    }
  }
  for (let boundary = 0; boundary <= 24; boundary += 1) {
    const top = barY + boundary * rowHeight;
    const hour = boundary % 2 === 0;
    if (hour) {
      parts.push(`<text x="${x + 74}" y="${top + 7}" text-anchor="end" class="vertical-tick">${clock(startMinute + boundary * 30)}</text>`);
      if (boundary > 0 && boundary < 24) {
        for (const bar of bars) {
          parts.push(`<rect x="${bar.x}" y="${top - 3}" width="${bar.width}" height="6" fill="#0B1625" opacity="0.95"/>`);
        }
      }
    }
    parts.push(`<rect x="${x + (hour ? 84 : 88)}" y="${top}" width="${hour ? 8 : 4}" height="${hour ? 2 : 1}" fill="${hour ? "#DCE6F1" : "#718198"}"/>`);
  }
  return parts.join("");
}

async function renderVerticalScheduleImage({ queue, subQueue, day, previous, current, scheduleDate }) {
  const label = day === "tomorrow" ? "Завтра" : "Сьогодні";
  const outages = drawOutages(current, 140);
  const totalsY = 140 + outages.rows * 60 + 20;
  const timelineY = totalsY + 30;
  const height = timelineY + 48 + 24 * 26 + 35;
  const hasYellow = [current, previous].some(item =>
    item?.timePeriods?.some(period => (period.status || period.state) === 3)
  );
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height + (hasYellow ? 30 : 0)}" viewBox="0 0 ${WIDTH} ${height + (hasYellow ? 30 : 0)}">
    <style>text{font-family:DejaVu Sans,Noto Sans,Arial,sans-serif;fill:#F3F7FC}.title{font-size:36px;font-weight:700}.day{font-size:26px;font-weight:700}.outage{font-size:25px;font-weight:700}.duration{font-size:17px;fill:#E6C5C7}.empty{font-size:22px;font-weight:700;fill:#BDEAD0}.summary-label{font-size:21px;fill:#C3CFDE}.summary{font-size:25px;font-weight:700}.half{font-size:23px;font-weight:700}.row{font-size:20px;font-weight:700}.vertical-tick{font-size:22px;font-weight:700;fill:#DCE6F1}.legend{font-size:17px;fill:#C3CFDE}</style>
    <rect width="100%" height="100%" fill="#15202E"/>
    <text x="48" y="60" class="title">Черга ${escapeXml(queue)}.${escapeXml(subQueue)}</text>
    <text x="48" y="117" class="day">${label}${shortDate(scheduleDate, day === "tomorrow" ? 1 : 0)}</text>
    <text x="952" y="117" text-anchor="end" class="vertical-tick">Кожна клітинка · 30 хв</text>
    ${outages.svg}
    ${drawTotals(current, totalsY)}
    ${verticalPanel(current, previous, 0, 48, timelineY)}
    ${verticalPanel(current, previous, 720, 508, timelineY)}
    ${hasYellow ? `<rect x="48" y="${height}" width="17" height="17" fill="${COLORS[3]}"/><text x="75" y="${height + 15}" class="legend">Жовтий — можливе світло</text>` : ""}
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

module.exports = { renderScheduleImage, renderVerticalScheduleImage };
