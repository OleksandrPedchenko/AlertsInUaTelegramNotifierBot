"use strict";

const { randomUUID } = require("node:crypto");
const { getHeapStatistics } = require("node:v8");

function createPerformance(jobName, logger) {
  const runId = randomUUID();
  const heapLimitBytes = getHeapStatistics().heap_size_limit;
  let peakObservedHeapUsedBytes = 0;
  let notificationCount = 0;
  let imageGenerated = false;

  function memorySnapshot() {
    const memory = process.memoryUsage();
    peakObservedHeapUsedBytes = Math.max(peakObservedHeapUsedBytes, memory.heapUsed);
    return {
      rssBytes: memory.rss,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      heapLimitBytes,
      heapUtilizationPercent: memory.heapUsed / heapLimitBytes * 100,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
      peakObservedHeapUsedBytes
    };
  }

  const startedMemory = memorySnapshot();
  const startedCpu = process.cpuUsage();
  const startedAt = process.hrtime.bigint();

  function memorySince(start) {
    const current = memorySnapshot();
    return {
      ...current,
      rssDeltaBytes: current.rssBytes - start.rssBytes,
      heapUsedDeltaBytes: current.heapUsedBytes - start.heapUsedBytes,
      heapTotalDeltaBytes: current.heapTotalBytes - start.heapTotalBytes,
      externalDeltaBytes: current.externalBytes - start.externalBytes,
      arrayBuffersDeltaBytes: current.arrayBuffersBytes - start.arrayBuffersBytes
    };
  }

  function processElapsed() {
    const cpu = process.cpuUsage();
    const processWallMs = process.uptime() * 1000;
    const processUserCpuMs = cpu.user / 1000;
    const processSystemCpuMs = cpu.system / 1000;
    const processCpuMs = processUserCpuMs + processSystemCpuMs;
    return { processWallMs, processCpuMs, processUserCpuMs, processSystemCpuMs };
  }

  function emit(message, fields) {
    try {
      logger?.info?.(message, fields);
    } catch {
      // Observability must not change job outcomes.
    }
  }

  function elapsed(cpu, start) {
    const usage = process.cpuUsage(cpu);
    const wallMs = Number(process.hrtime.bigint() - start) / 1e6;
    const userCpuMs = usage.user / 1000;
    const systemCpuMs = usage.system / 1000;
    const cpuMs = userCpuMs + systemCpuMs;
    return { cpuMs, userCpuMs, systemCpuMs, wallMs,
      cpuUtilizationPercent: wallMs > 0 ? cpuMs / wallMs * 100 : 0 };
  }

  async function phase(name, operation) {
    const startMemory = memorySnapshot();
    const cpu = process.cpuUsage();
    const start = process.hrtime.bigint();
    let status = "success";
    try {
      return await operation();
    } catch (error) {
      status = "failure";
      throw error;
    } finally {
      emit("job_phase_performance", {
        event: "job_phase_performance", jobName, runId, phase: name, status,
        ...elapsed(cpu, start), ...memorySince(startMemory)
      });
    }
  }

  function phaseSync(name, operation) {
    const startMemory = memorySnapshot();
    const cpu = process.cpuUsage();
    const start = process.hrtime.bigint();
    let status = "success";
    try {
      return operation();
    } catch (error) {
      status = "failure";
      throw error;
    } finally {
      emit("job_phase_performance", {
        event: "job_phase_performance", jobName, runId, phase: name, status,
        ...elapsed(cpu, start), ...memorySince(startMemory)
      });
    }
  }

  return {
    runId, phase, phaseSync,
    setLogger(value) { logger = value; },
    addNotifications(count) { notificationCount += count || 0; },
    markImage() { imageGenerated = true; },
    finish(status) {
      emit("job_performance", {
        event: "job_performance", jobName, runId, status,
        notified: notificationCount > 0, notificationCount, imageGenerated,
        ...elapsed(startedCpu, startedAt), ...memorySince(startedMemory), ...processElapsed()
      });
    }
  };
}

module.exports = { createPerformance };
