"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

for (const [job, flag] of [["alerts", "ALERTS_ENABLED"], ["light", "LIGHT_ENABLED"]]) {
  test(`${job} disabled by ${flag} records a skipped run without changing state`, () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `${job}-disabled-`));
    try {
      const result = spawnSync(process.execPath, [path.join(__dirname, `../src/jobs/${job}/index.js`)], {
        cwd,
        env: { PATH: process.env.PATH, [flag]: "false", LOG_FILE_PATH: "job.log", LOKI_IP: "127.0.0.1", LOKI_TIMEOUT_MS: "100" },
        encoding: "utf8"
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(fs.readdirSync(cwd), ["job.log"]);
      const events = fs.readFileSync(path.join(cwd, "job.log"), "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(events.length, 1);
      assert.equal(events[0].event, "job_performance");
      assert.equal(events[0].status, "skipped");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}
