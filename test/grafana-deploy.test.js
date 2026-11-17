"use strict";

const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const { promisify } = require("node:util");
const test = require("node:test");

const execute = promisify(execFile);

test("dashboard deploy uses existing Loki, reuses UID, and validates every panel query", async () => {
  let saved;
  let queries = 0;
  const server = http.createServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer test-token");
    const url = new URL(request.url, "http://localhost");
    let body;
    if (url.pathname === "/api/health") body = { version: "13.1.1" };
    else if (url.pathname === "/api/datasources") body = [{ uid: "existing-loki", type: "loki", isDefault: true }];
    else if (url.pathname === "/api/folders") body = [{ uid: "existing-folder", title: "AlertsTgBot" }];
    else if (url.pathname === "/api/v1/provisioning/alert-rules") body = [{ uid: "existing-error-rule" }];
    else if (url.pathname === "/api/dashboards/uid/alerts-bot-cpu-performance") {
      if (!saved) { response.writeHead(404); response.end("missing"); return; }
      body = { dashboard: saved, meta: { folderUid: "existing-folder" } };
    } else if (url.pathname === "/api/dashboards/db") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(input.overwrite, true);
      assert.equal(input.dashboard.uid, "alerts-bot-cpu-performance");
      assert.ok(input.dashboard.panels.every(panel => !panel.datasource || panel.datasource.uid === "existing-loki"));
      saved = { ...input.dashboard, id: 7, version: (saved?.version || 0) + 1 };
      body = { url: "/d/alerts-bot-cpu-performance" };
    } else if (url.pathname === "/api/datasources/proxy/uid/existing-loki/loki/api/v1/query_range") {
      queries += 1;
      assert.ok(url.searchParams.get("query"));
      body = { status: "success", data: { result: [] } };
    } else { response.writeHead(404); response.end("missing"); return; }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const env = { ...process.env, GRAFANA_URL: `http://127.0.0.1:${server.address().port}`,
      GRAFANA_TOKEN: "test-token", GRAFANA_USER: "", GRAFANA_PASSWORD: "" };
    const script = path.join(__dirname, "../scripts/deploy-performance-dashboard.js");
    await execute(process.execPath, [script], { env });
    await execute(process.execPath, [script], { env });
    assert.equal(saved.id, 7);
    assert.equal(saved.version, 2);
    assert.equal(queries, 56);
  } finally {
    server.close();
  }
});
