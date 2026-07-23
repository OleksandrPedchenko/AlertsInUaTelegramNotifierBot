"use strict";

const http = require("http");

const DEFAULT_PORT = 3010;
const STATUS_LABELS = {
  1: "Світло є",
  2: "Світла немає",
  3: "Можливо є"
};

function createEmptyDay() {
  const rows = {};

  for (let queue = 1; queue <= 6; queue += 1) {
    for (let subQueue = 1; subQueue <= 2; subQueue += 1) {
      rows[`${queue}.${subQueue}`] = Array.from({ length: 48 }, () => 1);
    }
  }

  return rows;
}

function createDefaultState() {
  const now = new Date();
  const state = {
    updatedAt: `Оновлено mock server: ${now.toLocaleString("uk-UA")}`,
    days: {
      today: createEmptyDay(),
      tomorrow: createEmptyDay()
    }
  };

  state.days.today["5.1"].splice(34, 4, 2, 2, 3, 1);
  state.days.tomorrow["5.1"].splice(16, 4, 2, 2, 1, 1);

  return state;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeStatuses(statuses) {
  if (!Array.isArray(statuses)) {
    return Array.from({ length: 48 }, () => 1);
  }

  return Array.from({ length: 48 }, (_, index) => {
    const status = Number(statuses[index]);
    return [1, 2, 3].includes(status) ? status : 1;
  });
}

function normalizeDay(day) {
  const rows = createEmptyDay();

  if (!day || typeof day !== "object" || Array.isArray(day)) {
    return rows;
  }

  Object.keys(rows).forEach((key) => {
    rows[key] = normalizeStatuses(day[key]);
  });

  return rows;
}

function normalizeState(input) {
  const fallback = createDefaultState();
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : fallback;

  return {
    updatedAt:
      typeof source.updatedAt === "string" && source.updatedAt.trim()
        ? source.updatedAt.trim()
        : fallback.updatedAt,
    days: {
      today: normalizeDay(source.days?.today),
      tomorrow: normalizeDay(source.days?.tomorrow)
    }
  };
}

function renderHeader() {
  const startHours = Array.from({ length: 24 }, (_, hour) => {
    const label = String(hour).padStart(2, "0");
    return `<th colspan="2">з ${label}:00</th>`;
  }).join("");
  const endHours = Array.from({ length: 24 }, (_, hour) => {
    const label = String((hour + 1) % 24).padStart(2, "0");
    return `<th colspan="2">по ${label}:00</th>`;
  }).join("");

  return `
    <thead class="turnoff-scheduleui-table-thead">
      <tr>
        <th rowspan="3" colspan="2">№ черги / підчерги</th>
        <th colspan="48">Години доби</th>
      </tr>
      <tr>${startHours}</tr>
      <tr>${endHours}</tr>
    </thead>
  `;
}

function renderRows(day) {
  let html = "";

  for (let queue = 1; queue <= 6; queue += 1) {
    for (let subQueue = 1; subQueue <= 2; subQueue += 1) {
      const cells = day[`${queue}.${subQueue}`]
        .map(
          (status, index) =>
            `<td class="light_${status}" title="${indexToTime(index)} ${escapeHtml(
              STATUS_LABELS[status]
            )}">&nbsp;</td>`
        )
        .join("");
      const queueCell =
        subQueue === 1
          ? `<td class="turnoff-scheduleui-table-queue" rowspan="2">${queue} черга</td>`
          : "";
      html += `
        <tr>
          ${queueCell}
          <td class="turnoff-scheduleui-table-subqueue">${subQueue}</td>
          ${cells}
        </tr>
      `;
    }
  }

  return html;
}

function renderScheduleTable(day, label) {
  return `
    <div style="overflow-x:scroll; margin-top:5px;">
      <p style="text-align: center;"><b>${escapeHtml(label)}</b></p>
      <table class="turnoff-scheduleui-table">
        ${renderHeader()}
        <tbody>
          ${renderRows(day)}
        </tbody>
      </table>
    </div>
  `;
}

function renderPoeHtml(state) {
  const normalized = normalizeState(state);

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>POE mock schedule</title>
  <style>
    body { font-family: Arial, sans-serif; color: #1f2933; }
    table { border-collapse: collapse; min-width: 1280px; }
    th, td { border: 1px solid #c8d0d8; min-width: 18px; height: 22px; text-align: center; }
    th { background: #eef3f7; font-size: 12px; }
    .turnoff-scheduleui-table-queue, .turnoff-scheduleui-table-subqueue { min-width: 72px; }
    .light_1 { background: #d9f99d; }
    .light_2 { background: #fecaca; }
    .light_3 { background: #fde68a; }
  </style>
</head>
<body>
  <div class="gpvinfodetail">
    У зв'язку зі складною ситуацією в енергосистемі України, в Полтавській області
    <b>${escapeHtml(new Date().toLocaleDateString("uk-UA"))}</b><br>
    <b>Mock server</b> запроваджений ГПВ для локального налагодження.<br>
    ${renderScheduleTable(normalized.days.today, "Порядок відключення черг")}
    ${renderScheduleTable(normalized.days.tomorrow, "Порядок відключення черг на завтра")}
    <p>${escapeHtml(normalized.updatedAt)}</p>
  </div>
</body>
</html>`;
}

function indexToTime(index) {
  const start = index * 30;
  const end = start + 30;
  return `${minuteToTime(start)}-${minuteToTime(end)}`;
}

function minuteToTime(minutes) {
  return `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(
    minutes % 60
  ).padStart(2, "0")}`;
}

function renderBuilderPage() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Light POE Mock Builder</title>
  <style>
    :root {
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #17202a;
      background: #f7f9fb;
    }
    * { box-sizing: border-box; }
    body { margin: 0; }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 18px 24px;
      border-bottom: 1px solid #d8e0e8;
      background: #ffffff;
    }
    h1 { margin: 0; font-size: 20px; font-weight: 700; }
    main { padding: 20px 24px 28px; }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: end;
      gap: 12px;
      margin-bottom: 18px;
    }
    label { display: grid; gap: 6px; font-size: 13px; font-weight: 600; color: #34495e; }
    select, input {
      height: 36px;
      border: 1px solid #b7c4d1;
      border-radius: 6px;
      padding: 0 10px;
      background: #fff;
      color: #17202a;
      font: inherit;
    }
    button {
      height: 36px;
      border: 1px solid #9fb0c1;
      border-radius: 6px;
      padding: 0 12px;
      background: #ffffff;
      color: #17202a;
      font: inherit;
      font-weight: 650;
      cursor: pointer;
    }
    button:hover { background: #eef4f8; }
    .status { min-width: 180px; font-size: 13px; color: #526477; }
    .grid-wrap { overflow-x: auto; border: 1px solid #d8e0e8; background: #ffffff; }
    .grid {
      display: grid;
      grid-template-columns: 64px repeat(48, 28px);
      min-width: 1408px;
    }
    .cell, .hour, .hour-label, .time {
      border-right: 1px solid #e1e7ed;
      border-bottom: 1px solid #e1e7ed;
      min-height: 28px;
      display: grid;
      place-items: center;
      font-size: 11px;
      user-select: none;
    }
    .hour, .hour-label { background: #edf3f7; font-weight: 700; }
    .hour-label { grid-column: span 2; }
    .time { background: #f8fafc; color: #526477; }
    .cell { cursor: pointer; min-width: 0; width: 100%; padding: 0; }
    .cell[data-status="1"] { background: #d9f99d; }
    .cell[data-status="2"] { background: #fecaca; }
    .cell[data-status="3"] { background: #fde68a; }
    .legend { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 14px; font-size: 13px; }
    .legend span { display: inline-flex; align-items: center; gap: 6px; }
    .swatch { width: 18px; height: 18px; border: 1px solid #9fb0c1; border-radius: 4px; }
    .on { background: #d9f99d; }
    .off { background: #fecaca; }
    .maybe { background: #fde68a; }
    .links { display: flex; gap: 12px; flex-wrap: wrap; font-size: 13px; }
    .links a { color: #0f5f8c; }
    .editor {
      display: grid;
      gap: 10px;
      margin-top: 20px;
    }
    .editor-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    h2 { margin: 0; font-size: 16px; }
    textarea {
      width: 100%;
      min-height: 420px;
      resize: vertical;
      border: 1px solid #b7c4d1;
      border-radius: 6px;
      padding: 12px;
      background: #ffffff;
      color: #17202a;
      font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      tab-size: 2;
    }
  </style>
</head>
<body>
  <header>
    <h1>Light POE Mock Builder</h1>
    <div class="links">
      <a href="/customs/dynamicgpv-info.php" target="_blank">HTML endpoint</a>
      <a href="/api/state" target="_blank">State JSON</a>
    </div>
  </header>
  <main>
    <div class="toolbar">
      <label>Day
        <select id="day">
          <option value="today">Today</option>
          <option value="tomorrow">Tomorrow</option>
        </select>
      </label>
      <label>Queue
        <select id="queue">${Array.from(
          { length: 6 },
          (_, index) => `<option value="${index + 1}">${index + 1}</option>`
        ).join("")}</select>
      </label>
      <label>Subqueue
        <select id="subQueue"><option value="1">1</option><option value="2">2</option></select>
      </label>
      <label>Updated text
        <input id="updatedAt" size="36">
      </label>
      <button type="button" data-fill="1">All on</button>
      <button type="button" data-fill="2">All off</button>
      <button type="button" data-fill="3">All maybe</button>
      <button type="button" id="reset">Reset</button>
      <span class="status" id="status"></span>
    </div>
    <div class="grid-wrap"><div class="grid" id="grid"></div></div>
    <div class="legend">
      <span><i class="swatch on"></i>Світло є</span>
      <span><i class="swatch off"></i>Світла немає</span>
      <span><i class="swatch maybe"></i>Можливо є</span>
    </div>
    <section class="editor">
      <div class="editor-head">
        <h2>Returned HTML</h2>
        <div>
          <button type="button" id="loadGeneratedHtml">Load generated</button>
          <button type="button" id="saveHtml">Save HTML response</button>
          <button type="button" id="resetHtml">Use schedule builder</button>
        </div>
      </div>
      <textarea id="htmlEditor" spellcheck="false"></textarea>
    </section>
  </main>
  <script>
    const grid = document.querySelector("#grid");
    const day = document.querySelector("#day");
    const queue = document.querySelector("#queue");
    const subQueue = document.querySelector("#subQueue");
    const updatedAt = document.querySelector("#updatedAt");
    const htmlEditor = document.querySelector("#htmlEditor");
    const status = document.querySelector("#status");
    let state;
    let saveTimer;

    const key = () => queue.value + "." + subQueue.value;

    function setStatus(text) {
      status.textContent = text;
    }

    function renderGrid() {
      grid.textContent = "";
      grid.insertAdjacentHTML("beforeend", '<div class="hour"></div>');
      for (let hour = 0; hour < 24; hour += 1) {
        grid.insertAdjacentHTML("beforeend", '<div class="hour-label">' + String(hour).padStart(2, "0") + ':00</div>');
      }
      grid.insertAdjacentHTML("beforeend", '<div class="time">Time</div>');
      for (let index = 0; index < 48; index += 1) {
        const minutes = index * 30;
        const time = String(Math.floor(minutes / 60)).padStart(2, "0") + ':' + String(minutes % 60).padStart(2, "0");
        grid.insertAdjacentHTML("beforeend", '<div class="time">' + time + '</div>');
      }
      grid.insertAdjacentHTML("beforeend", '<div class="time">State</div>');
      state.days[day.value][key()].forEach((value, index) => {
        const cell = document.createElement("button");
        cell.type = "button";
        cell.className = "cell";
        cell.dataset.status = String(value);
        cell.title = "Click to cycle status";
        cell.textContent = String(value);
        cell.addEventListener("click", () => {
          const next = value === 1 ? 2 : value === 2 ? 3 : 1;
          state.days[day.value][key()][index] = next;
          renderGrid();
          queueSave();
        });
        grid.appendChild(cell);
      });
    }

    async function loadState() {
      const response = await fetch("/api/state");
      state = await response.json();
      updatedAt.value = state.updatedAt;
      renderGrid();
      setStatus("Loaded");
    }

    async function loadHtml() {
      const response = await fetch("/api/html");
      const payload = await response.json();
      htmlEditor.value = payload.html;
      setStatus(payload.mode === "custom" ? "Loaded custom HTML" : "Loaded generated HTML");
    }

    async function saveState() {
      setStatus("Saving...");
      state.updatedAt = updatedAt.value;
      const response = await fetch("/api/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state)
      });
      state = await response.json();
      updatedAt.value = state.updatedAt;
      renderGrid();
      setStatus("Saved " + new Date().toLocaleTimeString());
    }

    async function saveHtml() {
      setStatus("Saving HTML...");
      const response = await fetch("/api/html", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html: htmlEditor.value })
      });
      const payload = await response.json();
      htmlEditor.value = payload.html;
      setStatus("HTML response saved");
    }

    async function loadGeneratedHtml() {
      const response = await fetch("/api/html/generated");
      const payload = await response.json();
      htmlEditor.value = payload.html;
      setStatus("Generated HTML loaded into editor");
    }

    async function resetHtml() {
      const response = await fetch("/api/html", { method: "DELETE" });
      const payload = await response.json();
      htmlEditor.value = payload.html;
      setStatus("Endpoint uses schedule builder");
    }

    function queueSave() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveState, 200);
    }

    [day, queue, subQueue].forEach((select) => select.addEventListener("change", renderGrid));
    updatedAt.addEventListener("input", queueSave);
    document.querySelectorAll("[data-fill]").forEach((button) => {
      button.addEventListener("click", () => {
        state.days[day.value][key()] = Array.from({ length: 48 }, () => Number(button.dataset.fill));
        renderGrid();
        queueSave();
      });
    });
    document.querySelector("#reset").addEventListener("click", async () => {
      const response = await fetch("/api/reset", { method: "POST" });
      state = await response.json();
      updatedAt.value = state.updatedAt;
      renderGrid();
      setStatus("Reset");
      await loadHtml();
    });
    document.querySelector("#saveHtml").addEventListener("click", saveHtml);
    document.querySelector("#loadGeneratedHtml").addEventListener("click", loadGeneratedHtml);
    document.querySelector("#resetHtml").addEventListener("click", resetHtml);

    Promise.all([loadState(), loadHtml()]).catch((error) => setStatus(error.message));
  </script>
</body>
</html>`;
}

function send(response, statusCode, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });
  response.end(body);
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 5_000_000) {
        reject(new Error("Request body is too large"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function createMockServer(initialState = createDefaultState()) {
  let currentState = normalizeState(initialState);
  let customHtml = null;

  function getCurrentHtml() {
    return customHtml === null ? renderPoeHtml(currentState) : customHtml;
  }

  return http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");

    try {
      if (request.method === "GET" && url.pathname === "/") {
        send(response, 200, renderBuilderPage(), "text/html; charset=utf-8");
        return;
      }

      if (
        (request.method === "GET" && url.pathname === "/customs/dynamicgpv-info.php") ||
        (request.method === "POST" && url.pathname === "/customs/search-disconnection.php")
      ) {
        if (request.method === "POST") {
          await readRequestBody(request);
        }
        send(response, 200, getCurrentHtml(), "text/html; charset=utf-8");
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/state") {
        send(response, 200, JSON.stringify(currentState), "application/json; charset=utf-8");
        return;
      }

      if (["POST", "PUT"].includes(request.method) && url.pathname === "/api/state") {
        const body = await readRequestBody(request);
        currentState = normalizeState(JSON.parse(body || "{}"));
        send(response, 200, JSON.stringify(currentState), "application/json; charset=utf-8");
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/html") {
        send(
          response,
          200,
          JSON.stringify({
            html: getCurrentHtml(),
            mode: customHtml === null ? "generated" : "custom"
          }),
          "application/json; charset=utf-8"
        );
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/html/generated") {
        send(
          response,
          200,
          JSON.stringify({
            html: renderPoeHtml(currentState),
            mode: "generated"
          }),
          "application/json; charset=utf-8"
        );
        return;
      }

      if (["POST", "PUT"].includes(request.method) && url.pathname === "/api/html") {
        const body = await readRequestBody(request);
        const payload = JSON.parse(body || "{}");
        if (typeof payload.html !== "string") {
          throw new Error("html must be a string");
        }
        customHtml = payload.html;
        send(
          response,
          200,
          JSON.stringify({
            html: customHtml,
            mode: "custom"
          }),
          "application/json; charset=utf-8"
        );
        return;
      }

      if (request.method === "DELETE" && url.pathname === "/api/html") {
        customHtml = null;
        send(
          response,
          200,
          JSON.stringify({
            html: renderPoeHtml(currentState),
            mode: "generated"
          }),
          "application/json; charset=utf-8"
        );
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/reset") {
        currentState = createDefaultState();
        customHtml = null;
        send(response, 200, JSON.stringify(currentState), "application/json; charset=utf-8");
        return;
      }

      send(response, 404, "Not found");
    } catch (error) {
      send(response, 400, error.message);
    }
  });
}

function main() {
  const port = Number(process.env.LIGHT_MOCK_PORT || DEFAULT_PORT);
  const host = process.env.LIGHT_MOCK_HOST || "127.0.0.1";
  const server = createMockServer();

  server.listen(port, host, () => {
    const baseUrl = `http://${host}:${port}`;
    console.log(`Light mock builder: ${baseUrl}/`);
    console.log(`LIGHT_POE_URL=${baseUrl}/customs/dynamicgpv-info.php`);
    console.log(`LIGHT_POE_POST_URL=${baseUrl}/customs/search-disconnection.php`);
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  createDefaultState,
  createMockServer,
  normalizeState,
  renderPoeHtml
};
