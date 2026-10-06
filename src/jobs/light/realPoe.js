"use strict";

const path = require("node:path");
const { createEnvReader } = require("../../lib/config");
const { createFallbackLogger, runPluginJob } = require("../../lib/runner");
const { DEFAULT_POE_URL, loadLightConfig } = require("./config");
const { lightPlugin } = require("./plugin");
const { parseClockTime } = require("./scenarios");

function parseNumber(value, name, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return number;
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--always") {
      options.always = true;
      continue;
    }
    const names = { "--time": "time", "--queue": "queue", "--subqueue": "subQueue", "--lead": "leadMinutes" };
    if (!names[arg] || !args[index + 1]) throw new Error(`Unknown or incomplete option: ${arg}`);
    options[names[arg]] = args[++index];
  }
  return options;
}

async function runRealPoe({ time, queue = 5, subQueue = 1, leadMinutes = 10, always = false,
  cwd = process.cwd(), env = process.env, fetchImpl, logger } = {}) {
  const currentMinute = parseClockTime(time);
  const selectedQueue = parseNumber(queue, "queue", 1, 6);
  const selectedSubQueue = parseNumber(subQueue, "subqueue", 1, 2);
  const selectedLead = parseNumber(leadMinutes, "lead", 0, 1440);
  const realEnv = {
    ...env,
    LIGHT_SUBSCRIPTIONS_FILE: "",
    LIGHT_POE_URL: DEFAULT_POE_URL,
    LIGHT_USE_STUB: "false",
    LIGHT_QUEUE: String(selectedQueue),
    LIGHT_SUB_QUEUE: String(selectedSubQueue),
    LIGHT_CURRENT_MINUTE: String(currentMinute),
    LIGHT_OUTAGE_REMINDER_BEFORE_MINUTES: String(selectedLead),
    LIGHT_ALWAYS_SEND_TG_MESSAGE: String(always),
    LIGHT_LOCK_FILE_PATH: path.join(cwd, ".light-poe-test.lock"),
    LIGHT_STATE_FILE_PATH: path.join(cwd, ".light-poe-test-state.json")
  };
  const config = loadLightConfig(realEnv, createEnvReader(realEnv, { cwd }));
  return runPluginJob(lightPlugin, realEnv, {
    config,
    cwd,
    logger: logger || createFallbackLogger(),
    fetchImpl
  });
}

async function main() {
  require("dotenv").config({ quiet: true });
  const options = parseArgs(process.argv.slice(2));
  if (!options.time) throw new Error("Specify --time HH:MM, for example --time 16:50");
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
  const result = await runRealPoe({ ...options, logger });
  console.log(`Real POE at ${options.time}: ${result.notified ? "Telegram message sent" : "no new notification"}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, runRealPoe };
