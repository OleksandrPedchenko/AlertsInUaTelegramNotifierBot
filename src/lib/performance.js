"use strict";

const { randomUUID } = require("node:crypto");

function createPerformance(jobName, logger) {
  const runId = randomUUID();
  const startedCpu = process.cpuUsage();
  const startedAt = process.hrtime.bigint();
  let notificationCount = 0;
  let imageGenerated = false;

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
        ...elapsed(cpu, start)
      });
    }
  }

  function phaseSync(name, operation) {
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
        ...elapsed(cpu, start)
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
        ...elapsed(startedCpu, startedAt)
      });
    }
  };
}

module.exports = { createPerformance };
