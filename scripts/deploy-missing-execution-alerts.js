"use strict";

const base = (process.env.GRAFANA_URL || "http://192.168.0.41:3000").replace(/\/$/, "");
const token = process.env.GRAFANA_TOKEN;
const basic = process.env.GRAFANA_USER && process.env.GRAFANA_PASSWORD
  ? Buffer.from(`${process.env.GRAFANA_USER}:${process.env.GRAFANA_PASSWORD}`).toString("base64") : null;
if (!token && !basic) {
  console.error("Set GRAFANA_TOKEN or GRAFANA_USER and GRAFANA_PASSWORD (do not commit credentials).");
  process.exit(2);
}

async function api(route, options = {}) {
  const response = await fetch(`${base}${route}`, {
    ...options,
    headers: {
      Authorization: token ? `Bearer ${token}` : `Basic ${basic}`,
      ...(options.body ? { "Content-Type": "application/json", "X-Disable-Provenance": "true" } : {})
    }
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status} ${body.slice(0, 300)}`);
  return body ? JSON.parse(body) : null;
}

function buildRule(source, existing, job) {
  const data = structuredClone(source.data);
  const query = data.find(item => item.refId === "A");
  const condition = data.find(item => item.refId === source.condition);
  if (!query?.model?.expr || !condition?.model?.conditions?.[0]?.evaluator) {
    throw new Error("Existing error rule has an unsupported query or threshold model");
  }
  query.model.expr = `sum(count_over_time({app=~"alerts-tg-bot|poe-notifier",level="info",job="${job}"} | json | event="job_performance" | status="success" | __error__="" [5m])) or vector(0)`;
  condition.model.conditions[0].evaluator = { type: "lt", params: [1] };
  const name = job === "alerts" ? "Alerts" : "Light";
  return {
    uid: existing?.uid,
    title: `AlertsTgBot: missing ${name} success`,
    folderUID: source.folderUID,
    ruleGroup: source.ruleGroup,
    orgId: source.orgID,
    condition: source.condition,
    data,
    noDataState: "Alerting",
    execErrState: "Alerting",
    for: "0s",
    keepFiringFor: "0s",
    notification_settings: source.notification_settings,
    annotations: {
      summary: `${name} job has not completed successfully for 5 minutes.`,
      description: `The ${name} timer runs every minute. No successful job_performance event reached Loki in the last 5 minutes. Check the service/timer, job logs, and Loki delivery. A query error can also fire this rule.`
    },
    labels: existing?.labels || {},
    isPaused: false
  };
}

async function main() {
  const rules = await api("/api/v1/provisioning/alert-rules");
  const source = rules.find(rule => rule.title === "AlertsTgBot: error logs");
  if (!source?.notification_settings?.receiver) {
    throw new Error("Existing error rule with a direct Telegram contact point is required");
  }
  for (const job of ["alerts", "light"]) {
    const title = `AlertsTgBot: missing ${job === "alerts" ? "Alerts" : "Light"} success`;
    const existing = rules.find(rule => rule.title === title);
    const rule = buildRule(source, existing, job);
    const route = existing
      ? `/api/v1/provisioning/alert-rules/${encodeURIComponent(existing.uid)}`
      : "/api/v1/provisioning/alert-rules";
    const saved = await api(route, { method: existing ? "PUT" : "POST", body: JSON.stringify(rule) });
    if (saved.title !== title) throw new Error(`Grafana did not save ${title}`);
    console.log(`${existing ? "Updated" : "Created"} ${title} (${saved.uid || existing?.uid})`);
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
