"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const { createTempDir } = require("./helpers");
const { readSubscriptionDocument, saveSubscriptionDocument } = require("../src/jobs/light/subscriptionFile");
const { createEditorServer } = require("../src/jobs/light/subscriptionEditor");

const legacy = { queues: { "6.1": { enabled: true, chatIds: ["chat-a"] } } };

test("conversion is idempotent, creates backup, and refuses stale writes", async () => {
  const dir = await createTempDir();
  const file = path.join(dir, "subscriptions.json");
  await fs.writeFile(file, JSON.stringify(legacy));
  const original = await readSubscriptionDocument(file);
  assert.deepEqual(original.normalized.queues["6.1"].chats, [{ chatId: "chat-a", settings: {} }]);
  await saveSubscriptionDocument(file, original.normalized, original.hash);
  assert.deepEqual(JSON.parse(await fs.readFile(`${file}.bak`, "utf8")), legacy);
  const converted = await readSubscriptionDocument(file);
  assert.deepEqual(converted.normalized, original.normalized);
  await assert.rejects(saveSubscriptionDocument(file, original.normalized, original.hash), /changed/);
  assert.deepEqual((await readSubscriptionDocument(file)).normalized, converted.normalized);
});

test("editor saves valid changes and rejects cross-origin and stale edits", async () => {
  const dir = await createTempDir();
  const file = path.join(dir, "subscriptions.json");
  await fs.writeFile(file, JSON.stringify(legacy));
  const server = createEditorServer({ filePath: file, host: "127.0.0.1", defaults: {} });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Save subscriptions/);
    const loaded = await (await fetch(`${base}/api/subscriptions`)).json();
    const invalid = structuredClone(loaded.document);
    invalid.queues["6.1"].chats[0].settings.unexpected = true;
    const rejected = await fetch(`${base}/api/subscriptions`, {
      method: "PUT", headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ document: invalid, hash: loaded.hash })
    });
    assert.equal(rejected.status, 400);
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), legacy);
    loaded.document.queues["6.1"].chats[0].settings.pinTodaySchedule = false;
    const body = JSON.stringify({ document: loaded.document, hash: loaded.hash });
    const badOrigin = await fetch(`${base}/api/subscriptions`, {
      method: "PUT", headers: { "Content-Type": "application/json", Origin: "http://elsewhere" }, body
    });
    assert.equal(badOrigin.status, 403);
    const saved = await fetch(`${base}/api/subscriptions`, {
      method: "PUT", headers: { "Content-Type": "application/json", Origin: base }, body
    });
    assert.equal(saved.status, 200);
    assert.equal((await readSubscriptionDocument(file)).normalized.queues["6.1"].chats[0].settings.pinTodaySchedule, false);
    const stale = await fetch(`${base}/api/subscriptions`, {
      method: "PUT", headers: { "Content-Type": "application/json", Origin: base }, body
    });
    assert.equal(stale.status, 409);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("editor opens an all-disabled template so the first chat can be enabled", async () => {
  const dir = await createTempDir();
  const file = path.join(dir, "subscriptions.json");
  await fs.writeFile(file, JSON.stringify({ queues: { "6.1": { enabled: false, chatIds: [] } } }));
  const server = createEditorServer({ filePath: file, host: "127.0.0.1", defaults: {} });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const loaded = await (await fetch(`${base}/api/subscriptions`)).json();
    assert.equal(loaded.document.queues["6.1"].enabled, false);
    loaded.document.queues["6.1"].enabled = true;
    loaded.document.queues["6.1"].chats.push({ chatId: "first", settings: {} });
    const saved = await fetch(`${base}/api/subscriptions`, {
      method: "PUT", headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ document: loaded.document, hash: loaded.hash })
    });
    assert.equal(saved.status, 200);
    assert.equal((await readSubscriptionDocument(file)).normalized.queues["6.1"].chats[0].chatId, "first");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
