"use strict";

const fs = require("node:fs");
const path = require("node:path");

const [job, value] = process.argv.slice(2);
const key = { alerts: "ALERTS_ENABLED", poe: "LIGHT_ENABLED" }[job];

if (!key || !["true", "false"].includes(value)) {
  console.error("Usage: node scripts/job-toggle.js <alerts|poe> <true|false>");
  process.exitCode = 1;
} else {
  try {
    const envFile = path.join(process.cwd(), ".env");
    const contents = fs.readFileSync(envFile, "utf8");
    const newline = contents.includes("\r\n") ? "\r\n" : "\n";
    const lines = contents.split(/\r?\n/);
    const flagLine = new RegExp(`^[ \t]*(?:export[ \t]+)?${key}[ \t]*=`);
    let found = false;
    for (let index = 0; index < lines.length; index += 1) {
      if (flagLine.test(lines[index])) {
        lines[index] = `${key}=${value}`;
        found = true;
      }
    }
    if (!found) lines.splice(lines.length - (lines.at(-1) === "" ? 1 : 0), 0, `${key}=${value}`);
    fs.writeFileSync(envFile, lines.join(newline));
    console.log(`${key}=${value}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
