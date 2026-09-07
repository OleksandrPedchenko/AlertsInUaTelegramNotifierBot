"use strict";

const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");
const test = require("node:test");

const { createEnvReader } = require("../src/lib/config");
const { runPluginJob } = require("../src/lib/runner");
const { writeJobState } = require("../src/lib/stateStore");
const { loadLightConfig } = require("../src/jobs/light/config");
const { createDefaultState, createMockServer, renderPoeHtml } = require("../src/jobs/light/mockServer");
const { parseLightSchedule } = require("../src/jobs/light/parser");
const { encodePostBody, lightPlugin } = require("../src/jobs/light/plugin");
const { createMemoryLogger, createSilentLogger, createTempDir, createTextResponse } = require("./helpers");

function row(statuses) {
  return `<tr><td>label</td>${statuses
    .map((status) => `<td class="light_${status}"></td>`)
    .join("")}</tr>`;
}

function createPoeHtml(selectedToday = [1, 1, 2, 3], selectedTomorrow = [2, 2, 1]) {
  return `
    <html>
      <body>
        <div class="gpvinfodetail"><span>ignored</span><span>Updated 10:00</span></div>
        <table>
          <tbody>
            ${row([1])}
            ${row([2])}
            ${row([3])}
            ${row(selectedToday)}
          </tbody>
        </table>
        <table>
          <tbody>
            ${row([1])}
            ${row([2])}
            ${row([3])}
            ${row(selectedTomorrow)}
          </tbody>
        </table>
      </body>
    </html>
  `;
}

function buildLightConfig(dir, overrides = {}) {
  const env = {
    TG_BOT_TOKEN: "tg-token",
    TG_CHAT_ID: "tg-chat",
    LIGHT_QUEUE: "2",
    LIGHT_SUB_QUEUE: "2",
    LIGHT_LOCK_FILE_PATH: path.join(dir, "light.lock"),
    LIGHT_STATE_FILE_PATH: path.join(dir, "light-state.json"),
    LOG_FILE_PATH: path.join(dir, "light.log"),
    LIGHT_HTTP_RETRY_BASE_DELAY_MS: "100",
    LIGHT_TG_HTTP_RETRY_BASE_DELAY_MS: "100",
    ...overrides
  };

  return loadLightConfig(env, createEnvReader(env, { cwd: dir }));
}

function createLightFetch(html, onTelegram) {
  return async (url, options = {}) => {
    if (String(url).includes("api.telegram.org")) {
      if (onTelegram) {
        onTelegram(JSON.parse(options.body));
      }
      return createTextResponse(200, JSON.stringify({ ok: true }));
    }

    if (options.method === "POST") {
      return createTextResponse(200, "post ok");
    }

    return createTextResponse(200, html);
  };
}

test("light config reads LIGHT keys and falls back to xbar VAR keys", async () => {
  const dir = await createTempDir();
  const env = {
    TG_BOT_TOKEN: "tg-token",
    TG_CHAT_ID: "tg-chat",
    VAR_QUEUE: "4",
    VAR_SUB_QUEUE: "2",
    LIGHT_LOCK_FILE_PATH: path.join(dir, "light.lock"),
    LIGHT_STATE_FILE_PATH: path.join(dir, "light-state.json")
  };
  const config = loadLightConfig(env, createEnvReader(env, { cwd: dir }));

  assert.equal(config.poe.queue, 4);
  assert.equal(config.poe.subQueue, 2);
  assert.equal(config.telegram.chatId, "tg-chat");
  assert.equal(config.job.useStub, false);
  assert.equal(config.job.stubFilePath, path.resolve(dir, "light-example.html"));
  assert.equal(config.gemini.enabled, false);
});

test("light config defaults Gemini to flash lite latest model", async () => {
  const dir = await createTempDir();
  const config = buildLightConfig(dir, {
    GEMINI_API_KEY: "gemini-key"
  });

  assert.equal(config.gemini.enabled, true);
  assert.equal(config.gemini.model, "models/gemini-flash-lite-latest");
});

test("light config allows localhost http mock URLs only", async () => {
  const dir = await createTempDir();
  const config = buildLightConfig(dir, {
    LIGHT_POE_URL: "http://127.0.0.1:3010/customs/dynamicgpv-info.php",
    LIGHT_POE_POST_URL: "http://localhost:3010/customs/search-disconnection.php"
  });

  assert.equal(config.poe.url, "http://127.0.0.1:3010/customs/dynamicgpv-info.php");
  assert.equal(config.poe.postUrl, "http://localhost:3010/customs/search-disconnection.php");

  assert.throws(
    () =>
      buildLightConfig(dir, {
        LIGHT_POE_URL: "http://example.com/customs/dynamicgpv-info.php"
      }),
    /LIGHT_POE_URL must use https/
  );
});

test("light mock server renders parser-compatible POE HTML", () => {
  const state = createDefaultState();
  state.updatedAt = "Mock updated 12:30";
  state.days.today["5.1"] = Array.from({ length: 48 }, (_, index) =>
    index < 2 ? 1 : index < 4 ? 2 : 3
  );
  state.days.tomorrow["5.1"] = Array.from({ length: 48 }, (_, index) => (index < 4 ? 2 : 1));

  const schedule = parseLightSchedule(renderPoeHtml(state), 5, 1, {
    now: new Date("2026-06-30T01:15:00")
  });

  assert.equal(schedule.updatedAt, "Mock updated 12:30");
  assert.deepEqual(
    schedule.today.timePeriods.map(({ status, time, current, durationMinutes }) => ({
      status,
      time,
      current,
      durationMinutes
    })),
    [
      { status: 1, time: "00:00 - 01:00", current: false, durationMinutes: 60 },
      { status: 2, time: "01:00 - 02:00", current: true, durationMinutes: 60 },
      { status: 3, time: "02:00 - 24:00", current: false, durationMinutes: 1320 }
    ]
  );
  assert.equal(schedule.tomorrow.timePeriods[0].status, 2);
  assert.equal(schedule.tomorrow.timePeriods[0].durationMinutes, 120);
});

test("light mock server can override returned HTML from API", async () => {
  const server = createMockServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const customHtml = "<html><body><div class=\"gpvinfodetail\">custom mock</div></body></html>";
    const saveResponse = await fetch(`${baseUrl}/api/html`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html: customHtml })
    });
    const savePayload = await saveResponse.json();
    assert.equal(savePayload.mode, "custom");
    assert.equal(savePayload.html, customHtml);

    const endpointResponse = await fetch(`${baseUrl}/customs/dynamicgpv-info.php`);
    assert.equal(await endpointResponse.text(), customHtml);

    const resetResponse = await fetch(`${baseUrl}/api/html`, { method: "DELETE" });
    const resetPayload = await resetResponse.json();
    assert.equal(resetPayload.mode, "generated");
    assert.match(resetPayload.html, /turnoff-scheduleui-table/);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

test("light parser preserves xbar row offset and segment grouping", () => {
  const schedule = parseLightSchedule(createPoeHtml(), 2, 2, {
    now: new Date("2026-06-30T00:15:00")
  });

  assert.equal(schedule.updatedAt, "Updated 10:00");
  assert.deepEqual(
    schedule.today.timePeriods.map(({ status, time, current, durationMinutes }) => ({
      status,
      time,
      current,
      durationMinutes
    })),
    [
      { status: 1, time: "00:00 - 01:00", current: true, durationMinutes: 60 },
      { status: 2, time: "01:00 - 01:30", current: false, durationMinutes: 30 },
      { status: 3, time: "01:30 - 02:00", current: false, durationMinutes: 30 }
    ]
  );
  assert.deepEqual(
    schedule.today.timePeriods.map(({ state, startMin, endMin }) => ({
      state,
      startMin,
      endMin
    })),
    [
      { state: 1, startMin: 0, endMin: 60 },
      { state: 2, startMin: 60, endMin: 90 },
      { state: 3, startMin: 90, endMin: 120 }
    ]
  );
  assert.equal(schedule.today.totalTimeOn, 90);
  assert.equal(schedule.today.totalTimeOff, 30);
});

test("light post body keeps xbar disconn encoding", () => {
  assert.equal(
    encodePostBody({ city_name: "с.Зайченці" }),
    `disconn=${encodeURIComponent(JSON.stringify({ city_name: "с.Зайченці" }))}`
  );
});

test("light runner skips notification when selected queue fingerprint is unchanged", async () => {
  const dir = await createTempDir();
  const html = createPoeHtml();
  const config = buildLightConfig(dir);
  const previousState = {
    ...parseLightSchedule(html, config.poe.queue, config.poe.subQueue),
    sourceUrl: config.poe.url,
    responseStatus: 200,
    postResponseStatus: 200
  };

  await writeJobState(
    config.job.stateFilePath,
    lightPlugin.getStateKey(config),
    previousState,
    lightPlugin.getStateFingerprint(previousState)
  );

  let telegramCalls = 0;
  const result = await runPluginJob(lightPlugin, {}, {
    config,
    logger: createSilentLogger(),
    fetchImpl: createLightFetch(html, () => {
      telegramCalls += 1;
    })
  });

  assert.equal(result.changed, false);
  assert.equal(result.notified, false);
  assert.equal(telegramCalls, 0);
});

test("light runner sends upcoming outage reminder only once", async () => {
  const dir = await createTempDir();
  const html = createPoeHtml([1, 1, 2, 3]);
  const config = buildLightConfig(dir, {
    LIGHT_CURRENT_MINUTE: "55",
    LIGHT_OUTAGE_REMINDER_BEFORE_MINUTES: "10"
  });

  const previousState = {
    ...parseLightSchedule(html, config.poe.queue, config.poe.subQueue, {
      now: new Date("2026-06-30T00:55:00")
    }),
    sourceUrl: config.poe.url,
    currentMinute: 55,
    responseStatus: 200,
    postResponseStatus: 200
  };

  await writeJobState(
    config.job.stateFilePath,
    lightPlugin.getStateKey(config),
    previousState,
    lightPlugin.getStateFingerprint(previousState)
  );

  const telegramMessages = [];
  const firstResult = await runPluginJob(lightPlugin, {}, {
    config,
    logger: createSilentLogger(),
    fetchImpl: createLightFetch(html, (body) => {
      telegramMessages.push(body.text);
    })
  });

  assert.equal(firstResult.changed, false);
  assert.equal(firstResult.notified, true);
  assert.equal(telegramMessages.length, 1);
  assert.match(telegramMessages[0], /Нагадування про відключення/);
  assert.match(telegramMessages[0], /З 01:00 - 01:30 буде відключення світла/);
  assert.match(telegramMessages[0], /Початок через 5 хв/);

  const secondResult = await runPluginJob(lightPlugin, {}, {
    config,
    logger: createSilentLogger(),
    fetchImpl: createLightFetch(html, (body) => {
      telegramMessages.push(body.text);
    })
  });

  assert.equal(secondResult.changed, false);
  assert.equal(secondResult.notified, false);
  assert.equal(telegramMessages.length, 1);
});

test("light runner sends Telegram notification when selected queue schedule changes", async () => {
  const dir = await createTempDir();
  const oldHtml = createPoeHtml([1, 1, 2, 3]);
  const newHtml = createPoeHtml([2, 2, 1, 1]);
  const config = buildLightConfig(dir);
  const previousState = {
    ...parseLightSchedule(oldHtml, config.poe.queue, config.poe.subQueue),
    sourceUrl: config.poe.url,
    responseStatus: 200,
    postResponseStatus: 200
  };

  await writeJobState(
    config.job.stateFilePath,
    lightPlugin.getStateKey(config),
    previousState,
    lightPlugin.getStateFingerprint(previousState)
  );

  let telegramBody = null;
  const logger = createMemoryLogger();
  const result = await runPluginJob(lightPlugin, {}, {
    config,
    logger,
    fetchImpl: createLightFetch(newHtml, (body) => {
      telegramBody = body;
    })
  });

  assert.equal(result.changed, true);
  assert.equal(result.notified, true);
  assert.equal(telegramBody.chat_id, "tg-chat");
  assert.match(telegramBody.text, /Графік світла: 2\.2 черга/);
  assert.match(telegramBody.text, /Було/);
  assert.match(telegramBody.text, /Стало/);
  assert.match(telegramBody.text, /Сьогодні/);
  assert.match(telegramBody.text, /Завтра/);
  assert.deepEqual(
    logger.entries.find((entry) => entry.message === "Gemini change summary skipped")?.meta,
    {
      reason: "disabled",
      queue: 2,
      subQueue: 2
    }
  );
});

test("light runner sends schedule change and outage reminder as separate messages", async () => {
  const dir = await createTempDir();
  const oldHtml = createPoeHtml([1, 1, 1, 3]);
  const newHtml = createPoeHtml([1, 1, 2, 3]);
  const config = buildLightConfig(dir, {
    LIGHT_CURRENT_MINUTE: "55",
    LIGHT_OUTAGE_REMINDER_BEFORE_MINUTES: "10"
  });
  const previousState = {
    ...parseLightSchedule(oldHtml, config.poe.queue, config.poe.subQueue, {
      now: new Date("2026-06-30T00:55:00")
    }),
    sourceUrl: config.poe.url,
    currentMinute: 55,
    responseStatus: 200,
    postResponseStatus: 200
  };

  await writeJobState(
    config.job.stateFilePath,
    lightPlugin.getStateKey(config),
    previousState,
    lightPlugin.getStateFingerprint(previousState)
  );

  const telegramMessages = [];
  const result = await runPluginJob(lightPlugin, {}, {
    config,
    logger: createSilentLogger(),
    fetchImpl: createLightFetch(newHtml, (body) => {
      telegramMessages.push(body.text);
    })
  });

  assert.equal(result.changed, true);
  assert.equal(result.notified, true);
  assert.equal(telegramMessages.length, 2);
  assert.match(telegramMessages[0], /Було/);
  assert.match(telegramMessages[0], /Стало/);
  assert.doesNotMatch(telegramMessages[0], /Нагадування про відключення/);
  assert.match(telegramMessages[1], /Нагадування про відключення/);
  assert.doesNotMatch(telegramMessages[1], /Було/);
  assert.doesNotMatch(telegramMessages[1], /Стало/);
});

test("light runner asks Gemini to explain changed segments when configured", async () => {
  const dir = await createTempDir();
  const oldHtml = createPoeHtml([1, 1, 2, 3]);
  const newHtml = createPoeHtml([2, 2, 1, 1]);
  const config = buildLightConfig(dir, {
    LIGHT_GEMINI_API_KEY: "gemini-key",
    LIGHT_GEMINI_RETRY_BASE_DELAY_MS: "100"
  });
  const previousState = {
    ...parseLightSchedule(oldHtml, config.poe.queue, config.poe.subQueue),
    sourceUrl: config.poe.url,
    responseStatus: 200,
    postResponseStatus: 200
  };

  await writeJobState(
    config.job.stateFilePath,
    lightPlugin.getStateKey(config),
    previousState,
    lightPlugin.getStateFingerprint(previousState)
  );

  let geminiBody = null;
  let telegramBody = null;
  const logger = createMemoryLogger();
  const result = await runPluginJob(lightPlugin, {}, {
    config,
    logger,
    fetchImpl: async (url, options = {}) => {
      const urlText = String(url);
      if (urlText.includes("generativelanguage.googleapis.com")) {
        geminiBody = JSON.parse(options.body);
        assert.match(urlText, /models\/gemini-flash-lite-latest:generateContent/);
        assert.match(urlText, /key=gemini-key/);
        return createTextResponse(
          200,
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: "Світло вимикатимуть раніше, але потім буде довший проміжок." }]
                }
              }
            ]
          })
        );
      }

      if (urlText.includes("api.telegram.org")) {
        telegramBody = JSON.parse(options.body);
        return createTextResponse(200, JSON.stringify({ ok: true }));
      }

      if (options.method === "POST") {
        return createTextResponse(200, "post ok");
      }

      return createTextResponse(200, newHtml);
    }
  });

  assert.equal(result.notified, true);
  assert.equal(config.gemini.enabled, true);
  assert.match(geminiBody.contents[0].parts[0].text, /OLD_SCHEDULE:/);
  assert.match(geminiBody.contents[0].parts[0].text, /NEW_SCHEDULE:/);
  assert.match(geminiBody.contents[0].parts[0].text, /OLD_OUTAGES:/);
  assert.match(geminiBody.contents[0].parts[0].text, /NEW_OUTAGES:/);
  assert.match(geminiBody.contents[0].parts[0].text, /CURRENT_MINUTE:\n\d+/);
  assert.match(geminiBody.contents[0].parts[0].text, /"state":1/);
  assert.match(geminiBody.contents[0].parts[0].text, /"startMin":0/);
  assert.match(geminiBody.contents[0].parts[0].text, /"endMin":60/);
  assert.match(geminiBody.contents[0].parts[0].text, /Не показуй state=3 як окрему зміну/);
  assert.match(geminiBody.contents[0].parts[0].text, /Не використовуй слово 'перемикання' у відповіді/);
  assert.match(geminiBody.contents[0].parts[0].text, /Для висновку орієнтуйся насамперед на OLD_OUTAGES і NEW_OUTAGES/);
  assert.doesNotMatch(geminiBody.contents[0].parts[0].text, /statusLabel/);
  assert.match(telegramBody.text, /Що змінилось/);
  assert.match(telegramBody.text, /Світло вимикатимуть раніше/);
  assert.match(telegramBody.text, /Було/);
  assert.match(telegramBody.text, /Стало/);
  assert.equal(
    logger.entries.some(
      (entry) =>
        entry.level === "info" &&
        entry.message === "Requesting Gemini change summary" &&
        entry.meta.model === "models/gemini-flash-lite-latest" &&
        entry.meta.previousTodayPeriods === 3 &&
        entry.meta.currentTodayPeriods === 2
    ),
    true
  );
  assert.equal(
    logger.entries.some(
      (entry) =>
        entry.level === "info" &&
        entry.message === "Gemini change summary generated" &&
        entry.meta.model === "models/gemini-flash-lite-latest" &&
        entry.meta.length > 0
    ),
    true
  );
});

test("light stub mode reads local html and skips POE requests", async () => {
  const dir = await createTempDir();
  const stubPath = path.join(dir, "light-example.html");
  await fs.writeFile(stubPath, createPoeHtml([1, 2, 2, 1]), "utf8");

  const config = buildLightConfig(dir, {
    LIGHT_USE_STUB: "true",
    LIGHT_STUB_FILE: stubPath,
    LIGHT_ALWAYS_SEND_TG_MESSAGE: "true"
  });

  let poeCalls = 0;
  let telegramBody = null;
  const result = await runPluginJob(lightPlugin, {}, {
    config,
    logger: createSilentLogger(),
    fetchImpl: async (url, options = {}) => {
      if (String(url).includes("api.telegram.org")) {
        telegramBody = JSON.parse(options.body);
        return createTextResponse(200, JSON.stringify({ ok: true }));
      }

      poeCalls += 1;
      return createTextResponse(200, "unexpected external response");
    }
  });

  assert.equal(result.notified, true);
  assert.equal(poeCalls, 0);
  assert.equal(telegramBody.chat_id, "tg-chat");
  assert.match(telegramBody.text, /Графік світла: 2\.2 черга/);
});
