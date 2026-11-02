"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const script = path.join(__dirname, "../scripts/job-toggle.js");

test("job toggles change only their own .env flag", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "job-toggle-"));
  const envFile = path.join(cwd, ".env");
  try {
    fs.writeFileSync(envFile, "# keep this\nALERTS_ENABLED=true\nLIGHT_ENABLED=true\nTG_BOT_TOKEN=secret\n");
    let expectedAlerts = "true";
    let expectedPoe = "true";
    for (const [job, value] of [["alerts", "false"], ["poe", "false"], ["alerts", "true"], ["poe", "true"]]) {
      const result = spawnSync(process.execPath, [script, job, value], { cwd, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      if (job === "alerts") expectedAlerts = value;
      else expectedPoe = value;
      assert.equal(fs.readFileSync(envFile, "utf8"),
        `# keep this\nALERTS_ENABLED=${expectedAlerts}\nLIGHT_ENABLED=${expectedPoe}\nTG_BOT_TOKEN=secret\n`);
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("job toggle adds a missing flag to .env", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "job-toggle-"));
  try {
    fs.writeFileSync(path.join(cwd, ".env"), "TG_BOT_TOKEN=secret\n");
    const result = spawnSync(process.execPath, [script, "poe", "false"], { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(cwd, ".env"), "utf8"),
      "TG_BOT_TOKEN=secret\nLIGHT_ENABLED=false\n");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
