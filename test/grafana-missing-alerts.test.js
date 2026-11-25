"use strict";

const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const { promisify } = require("node:util");
const test = require("node:test");

const execute = promisify(execFile);

test("missing-success provisioner creates and updates only its two rules", async () => {
  const source = {
    uid: "existing-error", title: "AlertsTgBot: error logs", folderUID: "folder", ruleGroup: "bot-log-errors", orgID: 1,
    condition: "C", notification_settings: { receiver: "TG Notification" },
    data: [
      { refId: "A", queryType: "instant", datasourceUid: "loki", relativeTimeRange: { from: 600, to: 0 },
        model: { refId: "A", queryType: "instant", instant: true, expr: "old error query" } },
      { refId: "C", datasourceUid: "__expr__", relativeTimeRange: { from: 0, to: 0 },
        model: { refId: "C", type: "threshold", expression: "A", conditions: [
          { evaluator: { type: "gt", params: [0] }, reducer: { type: "last", params: [] }, query: { params: ["C"] }, type: "query" }
        ] } }
    ]
  };
  const rules = [source];
  const changes = [];
  const server = http.createServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer test-token");
    const url = new URL(request.url, "http://localhost");
    if (url.pathname !== "/api/v1/provisioning/alert-rules" && !url.pathname.startsWith("/api/v1/provisioning/alert-rules/")) {
      response.writeHead(404); response.end("missing"); return;
    }
    if (request.method === "GET") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(rules));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rule = JSON.parse(Buffer.concat(chunks).toString());
    changes.push({ method: request.method, rule });
    if (request.method === "POST") rules.push({ ...rule, uid: `new-${rules.length}` });
    if (request.method === "PUT") {
      const index = rules.findIndex(item => item.uid === decodeURIComponent(url.pathname.split("/").at(-1)));
      rules[index] = { ...rule, uid: rules[index].uid };
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(rule));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const env = { ...process.env, GRAFANA_URL: `http://127.0.0.1:${server.address().port}`,
      GRAFANA_TOKEN: "test-token", GRAFANA_USER: "", GRAFANA_PASSWORD: "" };
    const script = path.join(__dirname, "../scripts/deploy-missing-execution-alerts.js");
    await execute(process.execPath, [script], { env });
    await execute(process.execPath, [script], { env });
    assert.deepEqual(changes.map(change => change.method), ["POST", "POST", "PUT", "PUT"]);
    assert.equal(rules[0], source);
    assert.equal(rules.length, 3);
    for (const job of ["alerts", "light"]) {
      const rule = rules.find(item => item.title === `AlertsTgBot: missing ${job === "alerts" ? "Alerts" : "Light"} success`);
      assert.ok(rule);
      assert.match(rule.data[0].model.expr, new RegExp(`job="${job}"`));
      assert.match(rule.data[0].model.expr, /status="success"/);
      assert.match(rule.data[0].model.expr, /\[5m\]\)\) or vector\(0\)$/);
      assert.deepEqual(rule.data[1].model.conditions[0].evaluator, { type: "lt", params: [1] });
      assert.equal(rule.noDataState, "Alerting");
      assert.equal(rule.execErrState, "Alerting");
      assert.equal(rule.for, "0s");
      assert.deepEqual(rule.notification_settings, source.notification_settings);
      assert.equal(rule.folderUID, source.folderUID);
      assert.equal(rule.ruleGroup, source.ruleGroup);
    }
  } finally {
    server.close();
  }
});
