"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { createEnvReader } = require("../src/lib/config");
const { runPluginJob } = require("../src/lib/runner");
const { loadLightConfig } = require("../src/jobs/light/config");
const { parseLightSchedule } = require("../src/jobs/light/parser");
const { lightPlugin } = require("../src/jobs/light/plugin");
const { createMockServer } = require("../src/jobs/light/mockServer");
const { createSilentLogger, createTempDir, createTextResponse } = require("./helpers");

test("mock serves editable parser-compatible POE HTML and POST endpoint", async () => {
  const server = createMockServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await (await fetch(base)).text();
    assert.match(page, /Returned HTML/);
    assert.match(page, /overflow-x:\s*auto/);
    const initial = await (await fetch(`${base}/customs/dynamicgpv-info.php`)).text();
    assert.ok(parseLightSchedule(initial, 5, 1).today.timePeriods.length);
    const cells = Array.from({ length: 48 }, (_, index) => index < 2 ? 2 : 1);
    const saved = await fetch(`${base}/api/state`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ days: { today: { "5.1": cells }, tomorrow: { "5.1": cells } } })
    });
    assert.equal(saved.status, 200);
    const generated = await (await fetch(`${base}/customs/dynamicgpv-info.php`)).text();
    const schedule = parseLightSchedule(generated, 5, 1);
    assert.equal(schedule.today.timePeriods[0].status, 2);
    assert.equal(schedule.today.timePeriods[0].durationMinutes, 60);
    assert.equal(schedule.tomorrow.timePeriods[0].status, 2);
    assert.equal((generated.match(/class="light_[123]"/g) || []).length, 12 * 48 * 2);
    const previewResponse = await fetch(`${base}/api/html/generated`);
    assert.equal(previewResponse.status, 200);
    assert.equal((await previewResponse.json()).mode, "generated");
    assert.equal(await (await fetch(`${base}/customs/dynamicgpv-info.php`)).text(), generated);
    const raw = "<html><body>custom response</body></html>";
    assert.equal((await fetch(`${base}/api/html`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html: raw })
    })).status, 200);
    assert.equal(await (await fetch(`${base}/customs/dynamicgpv-info.php`)).text(), raw);
    assert.equal((await fetch(`${base}/customs/search-disconnection.php`, { method: "POST" })).status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("light worker fetches only the local mock schedule and sends a schedule message", async () => {
  const server = createMockServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = await createTempDir();
  const env = {
    TG_BOT_TOKEN: "test-token", TG_CHAT_ID: "test-chat",
    LIGHT_POE_URL: `${base}/customs/dynamicgpv-info.php`,
    LIGHT_LOCK_FILE_PATH: path.join(dir, "light.lock"),
    LIGHT_STATE_FILE_PATH: path.join(dir, "state.json"),
    LOG_FILE_PATH: path.join(dir, "light.log")
  };
  const config = loadLightConfig(env, createEnvReader(env, { cwd: dir }));
  let message;
  const poeRequests = [];
  try {
    const result = await runPluginJob(lightPlugin, env, {
      config, logger: createSilentLogger(),
      fetchImpl: (url, options) => {
        if (String(url).includes("api.telegram.org")) {
          message = JSON.parse(options.body);
          return Promise.resolve(createTextResponse(200, JSON.stringify({ ok: true })));
        }
        poeRequests.push([String(url), options?.method || "GET"]);
        return fetch(url, options);
      }
    });
    assert.equal(result.notified, true);
    assert.equal(message.chat_id, "test-chat");
    assert.match(message.text, /Новий графік · черга 5\.1/);
    assert.deepEqual(poeRequests, [[`${base}/customs/dynamicgpv-info.php`, "GET"]]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
