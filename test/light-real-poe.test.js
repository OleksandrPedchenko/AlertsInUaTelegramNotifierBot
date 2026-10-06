"use strict";

const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const { runRealPoe, parseArgs } = require("../src/jobs/light/realPoe");
const { createSilentLogger, createTempDir, createTextResponse } = require("./helpers");

test("real POE command accepts HH:MM and rejects incomplete options", () => {
  assert.deepEqual(parseArgs(["--time", "16:50", "--queue", "3"]), { time: "16:50", queue: "3" });
  assert.throws(() => parseArgs(["--time"]), /incomplete/);
});

test("real POE command fetches official endpoints and uses isolated persistent state", async () => {
  const cwd = await createTempDir();
  const html = await readFile(path.join(__dirname, "../light-example.html"), "utf8");
  const requests = [];
  const messages = [];
  const fetchImpl = (url, options) => {
    requests.push([String(url), options?.method || "GET"]);
    if (String(url).includes("api.telegram.org")) {
      messages.push(JSON.parse(options.body));
      return Promise.resolve(createTextResponse(200, JSON.stringify({ ok: true })));
    }
    return Promise.resolve(createTextResponse(200, String(url).endsWith("dynamicgpv-info.php") ? html : "OK"));
  };
  const env = {
    TG_BOT_TOKEN: "test-token", LIGHT_TG_CHAT_ID: "demo-chat",
    LIGHT_POE_URL: "http://127.0.0.1:3010/customs/dynamicgpv-info.php",
    LIGHT_POE_POST_URL: "http://127.0.0.1:3010/customs/search-disconnection.php",
    LIGHT_USE_STUB: "true"
  };

  const first = await runRealPoe({ time: "16:50", leadMinutes: 0, cwd, env, fetchImpl, logger: createSilentLogger() });
  const second = await runRealPoe({ time: "16:50", leadMinutes: 0, cwd, env, fetchImpl, logger: createSilentLogger() });
  assert.equal(first.notified, true);
  assert.equal(second.notified, false);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].chat_id, "demo-chat");
  assert.ok(requests.some(([url, method]) => url === "https://www.poe.pl.ua/customs/dynamicgpv-info.php" && method === "GET"));
  assert.ok(requests.some(([url, method]) => url === "https://www.poe.pl.ua/customs/search-disconnection.php" && method === "POST"));
});
