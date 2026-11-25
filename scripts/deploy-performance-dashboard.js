"use strict";

const fs = require("node:fs");
const path = require("node:path");

const base = (process.env.GRAFANA_URL || "http://192.168.0.41:3000").replace(/\/$/, "");
const token = process.env.GRAFANA_TOKEN;
const basic = process.env.GRAFANA_USER && process.env.GRAFANA_PASSWORD
  ? Buffer.from(`${process.env.GRAFANA_USER}:${process.env.GRAFANA_PASSWORD}`).toString("base64") : null;
if (!token && !basic) {
  console.error("Set GRAFANA_TOKEN or GRAFANA_USER and GRAFANA_PASSWORD (do not commit credentials).");
  process.exit(2);
}
const auth = token ? `Bearer ${token}` : `Basic ${basic}`;
async function api(route, options = {}) {
  const response = await fetch(`${base}${route}`, {
    ...options,
    headers: { Authorization: auth, ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers }
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status} ${body.slice(0, 300)}`);
  return body ? JSON.parse(body) : null;
}
async function main() {
  const health = await api("/api/health");
  const datasources = await api("/api/datasources");
  const loki = process.env.GRAFANA_LOKI_UID
    ? datasources.find(source => source.uid === process.env.GRAFANA_LOKI_UID)
    : datasources.find(source => source.type === "loki" && source.isDefault)
      || datasources.find(source => source.type === "loki");
  if (!loki || loki.type !== "loki") throw new Error("No existing Loki datasource found");
  const folders = await api("/api/folders");
  const uid = "alerts-bot-cpu-performance";
  let existing = null;
  try { existing = await api(`/api/dashboards/uid/${uid}`); }
  catch (error) { if (!error.message.includes("HTTP 404")) throw error; }
  const beforeRules = await api("/api/v1/provisioning/alert-rules");
  const dashboard = JSON.parse(fs.readFileSync(path.join(__dirname, "../grafana/performance-dashboard.json"), "utf8"));
  const replaceDatasource = value => {
    if (Array.isArray(value)) return value.forEach(replaceDatasource);
    if (!value || typeof value !== "object") return;
    if (value.datasource?.uid === "${DS_LOKI}") value.datasource.uid = loki.uid;
    for (const nested of Object.values(value)) replaceDatasource(nested);
  };
  replaceDatasource(dashboard);
  dashboard.id = existing?.dashboard?.id || null;
  dashboard.version = existing?.dashboard?.version || 0;
  const folderUid = process.env.GRAFANA_FOLDER_UID || existing?.meta?.folderUid || undefined;
  const saved = await api("/api/dashboards/db", {
    method: "POST", body: JSON.stringify({ dashboard, folderUid, overwrite: true, message: "Update Alerts Bot CPU and RAM performance dashboard" })
  });
  const verified = await api(`/api/dashboards/uid/${uid}`);
  if (verified.dashboard.panels.some(panel => panel.datasource && panel.datasource.uid !== loki.uid)) {
    throw new Error("Saved panel datasource UID mismatch");
  }
  const afterRules = await api("/api/v1/provisioning/alert-rules");
  if (JSON.stringify(beforeRules) !== JSON.stringify(afterRules)) throw new Error("Grafana alert rules changed during deployment");
  const end = Date.now() * 1e6;
  for (const panel of verified.dashboard.panels) {
    for (const target of panel.targets || []) {
      const query = target.expr
        .replaceAll("${job:regex}", "alerts|light")
        .replaceAll("${cpu_threshold_ms}", "10")
        .replaceAll("${run_id}", "")
        .replaceAll("$__interval", "5m")
        .replaceAll("$__range", "1h");
      const params = new URLSearchParams({ query, start: String(end - 3600e9), end: String(end), step: "60" });
      const result = await api(`/api/datasources/proxy/uid/${loki.uid}/loki/api/v1/query_range?${params}`);
      if (result.status !== "success") throw new Error(`${panel.title} ${target.refId}: Loki query status ${result.status}`);
      console.log(`${panel.title} ${target.refId}: valid (${result.data?.result?.length || 0} series)`);
    }
  }
  console.log(JSON.stringify({ grafanaVersion: health.version, lokiDatasource: loki.uid,
    folders: folders.map(folder => ({ uid: folder.uid, title: folder.title })),
    dashboardUrl: new URL(saved.url, base).href, panelCount: verified.dashboard.panels.length,
    alertRulesUnchanged: true }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
