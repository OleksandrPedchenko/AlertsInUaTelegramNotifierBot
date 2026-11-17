"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createPerformance } = require("../src/lib/performance");
const { createMemoryLogger } = require("./helpers");

test("performance events correlate phases with one job and preserve failures", async () => {
  const logger = createMemoryLogger();
  const performance = createPerformance("light", logger);
  assert.equal(await performance.phase("fetch_http", async () => 42), 42);
  assert.throws(() => performance.phaseSync("parse_html", () => { throw new Error("bad html"); }), /bad html/);
  performance.addNotifications(2);
  performance.markImage();
  performance.finish("failure");

  const events = logger.entries.map(entry => entry.meta);
  assert.deepEqual(events.map(event => event.event), [
    "job_phase_performance", "job_phase_performance", "job_performance"
  ]);
  assert.ok(events.every(event => event.runId === performance.runId && event.jobName === "light"));
  assert.equal(events[1].status, "failure");
  assert.equal(events[2].status, "failure");
  assert.equal(events[2].notificationCount, 2);
  assert.equal(events[2].imageGenerated, true);
  assert.ok(events.every(event => event.cpuMs >= 0 && event.wallMs >= 0));
});

test("broken performance logger cannot break the operation", async () => {
  const performance = createPerformance("alerts", { info() { throw new Error("logger failed"); } });
  assert.equal(await performance.phase("fetch_http", async () => "ok"), "ok");
  performance.finish("success");
});
