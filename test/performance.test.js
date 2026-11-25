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

test("job and phase events report memory snapshots, deltas, and process lifetime", async () => {
  const logger = createMemoryLogger();
  const performance = createPerformance("light", logger);
  const allocated = await performance.phase("allocate", async () => Buffer.alloc(4 * 1024 * 1024));
  performance.finish("success");

  const [phase, job] = logger.entries.map(entry => entry.meta);
  for (const event of [phase, job]) {
    for (const key of ["rssBytes", "peakRssBytes", "heapUsedBytes", "heapTotalBytes",
      "heapLimitBytes", "heapUtilizationPercent", "externalBytes", "arrayBuffersBytes",
      "peakObservedHeapUsedBytes", "rssDeltaBytes", "heapUsedDeltaBytes",
      "heapTotalDeltaBytes", "externalDeltaBytes", "arrayBuffersDeltaBytes"]) {
      assert.equal(typeof event[key], "number", key);
    }
    assert.ok(event.peakRssBytes >= event.rssBytes);
    assert.ok(event.peakObservedHeapUsedBytes >= event.heapUsedBytes);
    assert.ok(event.heapLimitBytes >= event.heapTotalBytes);
    assert.ok(event.heapUtilizationPercent >= 0);
    assert.ok(event.heapUtilizationPercent <= 100);
  }
  assert.ok(job.processWallMs >= job.wallMs);
  assert.ok(job.processCpuMs >= job.cpuMs);
  assert.equal(job.processCpuMs, job.processUserCpuMs + job.processSystemCpuMs);
  assert.ok(phase.arrayBuffersDeltaBytes >= allocated.byteLength);
  assert.ok(phase.externalDeltaBytes >= allocated.byteLength);
});
