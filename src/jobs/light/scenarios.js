"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createEnvReader } = require("../../lib/config");
const { createFallbackLogger, runPluginJob } = require("../../lib/runner");
const { writeJobState } = require("../../lib/stateStore");
const { loadLightConfig } = require("./config");
const { loadSubscriptions, runFanout } = require("./fanout");
const { createDefaultState, createMockServer, renderPoeHtml } = require("./mockServer");
const { parseLightSchedule } = require("./parser");
const { lightPlugin } = require("./plugin");
const scenarioSchedule = require("./scenarioSchedule.json");

const CASES = Object.freeze({
  initial: { time: "12:00", description: "First schedule notification", seed: false },
  "schedule-change": { time: "12:00", description: "Today's outage extends by 30 minutes, with a real Gemini summary", gemini: true },
  "today-shorter": { time: "12:00", description: "Today's outage ends 30 minutes earlier without moving its start", gemini: true },
  "tomorrow-appears": { time: "12:00", description: "Tomorrow schedule first published without a comparison" },
  "tomorrow-change": { time: "12:00", description: "Tomorrow's outage shortens by 30 minutes, with a real Gemini summary", gemini: true },
  "double-change": { time: "12:00", description: "Two tomorrow outages change: one shortens and one extends", gemini: true },
  "off-reminder": { time: "20:50", description: "Queue 5.1 light off at its fixed 21:00 start" },
  "tentative-on": { time: "15:50", description: "Queue 5.1 tentative return begins at 16:00" },
  "midnight-off": { time: "23:50", queue: 2, subQueue: 1, description: "Queue 2.1 light off tomorrow at 00:00" },
  "midnight-tentative-on": { time: "23:50", queue: 1, subQueue: 2, description: "Queue 1.2 tentative return tomorrow at 00:00" },
  "schedule-and-off": { time: "20:50", description: "Tomorrow outage shortens and queue 5.1 has its fixed 21:00 off reminder", gemini: true }
});

function parseClockTime(value) {
  if (!/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value || "")) {
    throw new Error("Time must use HH:MM in 24-hour format (for example 16:50)");
  }
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function parseChoice(value, name, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return number;
}

function makeStates(caseName, keys) {
  const current = createDefaultState();
  const previous = createDefaultState();
  for (const state of [current, previous]) {
    state.updatedAt = `Демо: приклад POE від ${scenarioSchedule.capturedAt}`;
  }

  for (const key of keys) {
    for (const state of [current, previous]) {
      state.days.today[key] = [...scenarioSchedule.days.today[key]];
      state.days.tomorrow[key] = [...scenarioSchedule.days.tomorrow[key]];
    }
    const today = current.days.today[key];
    const tomorrow = current.days.tomorrow[key];
    if (caseName === "double-change") {
      const outages = tomorrow.flatMap((status, start) => {
        if (status !== 2 || (start > 0 && tomorrow[start - 1] === 2)) return [];
        const end = tomorrow.indexOf(3, start);
        return end - start >= 2 && tomorrow[end + 1] === 1 ? [{ start, end }] : [];
      });
      if (outages.length < 2) throw new Error(`Scenario schedule ${key} needs two outages`);
      const [shorter, longer] = outages;
      tomorrow[shorter.end - 1] = 3;
      tomorrow[shorter.end] = 1;
      tomorrow[longer.end] = 2;
      tomorrow[longer.end + 1] = 3;
    }
    if (["schedule-change", "today-shorter", "tomorrow-change", "schedule-and-off"].includes(caseName)) {
      const cells = ["tomorrow-change", "schedule-and-off"].includes(caseName) ? tomorrow : today;
      const firstOutage = cells.findIndex((status, index) =>
        status === 2 && index > 0 && cells[index - 1] === 1 &&
        (caseName === "schedule-change" || cells[index + 1] === 2));
      if (firstOutage < 0) throw new Error(`Scenario schedule ${key} has no suitable outage`);
      const end = cells.indexOf(3, firstOutage);
      if (end < 0 || cells[end + 1] !== 1) throw new Error(`Scenario schedule ${key} has no return period`);
      if (caseName === "schedule-change") {
        cells[end] = 2;
        cells[end + 1] = 3;
      } else {
        cells[end - 1] = 3;
        cells[end] = 1;
      }
    }
    if (["off-reminder", "tentative-on", "midnight-off", "midnight-tentative-on"].includes(caseName)) {
      previous.days.today[key] = [...today];
      previous.days.tomorrow[key] = [...tomorrow];
    }
  }
  return { current, previous };
}

async function runScenario({ caseName, time, queue, subQueue, leadMinutes = 10, env = process.env, fetchImpl, logger } = {}) {
  const scenario = CASES[caseName];
  if (!scenario) throw new Error(`Unknown case: ${caseName}. Run --list to see available cases.`);
  const currentMinute = parseClockTime(time || scenario.time);
  const selectedQueue = parseChoice(queue ?? scenario.queue ?? 5, "queue", 1, 6);
  const selectedSubQueue = parseChoice(subQueue ?? scenario.subQueue ?? 1, "subqueue", 1, 2);
  const selectedLead = parseChoice(leadMinutes, "lead", 1, 1440);
  if (scenario.gemini && !(env.LIGHT_GEMINI_API_KEY || env.GEMINI_API_KEY)) {
    throw new Error(`${caseName} requires LIGHT_GEMINI_API_KEY or GEMINI_API_KEY`);
  }

  const key = `${selectedQueue}.${selectedSubQueue}`;
  const subscriptionsFile = env.LIGHT_SUBSCRIPTIONS_FILE
    ? path.resolve(env.LIGHT_SUBSCRIPTIONS_FILE) : null;
  const subscriptions = subscriptionsFile ? await loadSubscriptions(subscriptionsFile) : null;
  if (subscriptions && (queue !== undefined || subQueue !== undefined)) {
    throw new Error("--queue and --subqueue apply only when LIGHT_SUBSCRIPTIONS_FILE is unset");
  }
  const keys = subscriptions
    ? [...new Set(subscriptions.map(({ queue, subQueue }) => `${queue}.${subQueue}`))] : [key];
  const enableGemini = scenario.gemini || (caseName === "tomorrow-appears" &&
    Boolean(env.LIGHT_GEMINI_API_KEY || env.GEMINI_API_KEY));
  const { current, previous } = makeStates(caseName, keys);
  const server = createMockServer(current);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "light-scenario-"));
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const scenarioEnv = {
      ...env,
      LIGHT_SUBSCRIPTIONS_FILE: subscriptionsFile || "",
      LIGHT_QUEUE: String(selectedQueue),
      LIGHT_SUB_QUEUE: String(selectedSubQueue),
      LIGHT_POE_URL: `${baseUrl}/customs/dynamicgpv-info.php`,
      LIGHT_USE_STUB: "false",
      LIGHT_ALWAYS_SEND_TG_MESSAGE: "false",
      LIGHT_OUTAGE_REMINDER_BEFORE_MINUTES: String(selectedLead),
      LIGHT_CURRENT_MINUTE: String(currentMinute),
      LIGHT_GEMINI_ENABLED: enableGemini ? "true" : "false",
      LIGHT_LOCK_FILE_PATH: path.join(tempDir, "light.lock"),
      LIGHT_STATE_FILE_PATH: path.join(tempDir, "state.json")
    };
    const config = loadLightConfig(scenarioEnv, createEnvReader(scenarioEnv, { cwd: tempDir }));
    if (scenario.seed !== false) {
      const destinations = subscriptions || [{ queue: selectedQueue, subQueue: selectedSubQueue }];
      const previousHtml = renderPoeHtml(previous);
      for (const destination of destinations) {
        const previousState = parseLightSchedule(previousHtml, destination.queue, destination.subQueue);
        if (caseName === "tomorrow-appears") {
          previousState.tomorrow = { timePeriods: [], totalTimeOn: 0, totalTimeOff: 0 };
        }
        const stateKey = subscriptions
          ? `light:${destination.queue}.${destination.subQueue}:chat:${destination.chatId}`
          : lightPlugin.getStateKey(config);
        await writeJobState(config.job.stateFilePath, stateKey, previousState,
          lightPlugin.getStateFingerprint(previousState));
      }
    }
    const options = {
      config,
      logger: logger || createFallbackLogger(),
      fetchImpl
    };
    const result = subscriptions
      ? await runFanout(scenarioEnv, options)
      : await runPluginJob(lightPlugin, scenarioEnv, options);
    return { ...result, notified: subscriptions ? result.notificationCount > 0 : result.notified,
      caseName, time: time || scenario.time, queue: selectedQueue, subQueue: selectedSubQueue };
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--list") {
      options.list = true;
      continue;
    }
    const names = { "--case": "caseName", "--time": "time", "--queue": "queue", "--subqueue": "subQueue", "--lead": "leadMinutes" };
    if (!names[arg] || !args[index + 1]) throw new Error(`Unknown or incomplete option: ${arg}`);
    options[names[arg]] = args[++index];
  }
  return options;
}

async function main() {
  require("dotenv").config({ quiet: true });
  const options = parseArgs(process.argv.slice(2));
  if (options.list) {
    for (const [name, scenario] of Object.entries(CASES)) {
      console.log(`${name.padEnd(18)} ${scenario.description} (default time ${scenario.time})`);
    }
    return;
  }
  if (!options.caseName) throw new Error("Specify --case NAME. Run --list to see available cases.");
  const logger = {
    info(message) {
      if (message === "Requesting Gemini change summary" || message === "Gemini change summary generated") {
        console.log(message);
      }
    },
    warn(message, details) {
      if (message.startsWith("Gemini")) console.warn(`${message}: ${details?.reason || "no summary"}`);
    },
    error(message) { console.error(message); },
    async flush() {}
  };
  const result = await runScenario({ ...options, logger });
  if (result.subscriptions) {
    console.log(`Case ${result.caseName} at ${result.time}: ${result.notificationCount} Telegram messages sent to ${result.subscriptions} subscriptions`);
  } else {
    console.log(`Case ${result.caseName} at ${result.time}, queue ${result.queue}.${result.subQueue}: ${result.notified ? "Telegram message sent" : "no message"}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { CASES, parseClockTime, runScenario };
