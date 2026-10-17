"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { parseSubscriptions, normalizeSubscriptions } = require("../src/jobs/light/subscriptions");

test("legacy destinations and per-chat settings normalize without changing identity", () => {
  const source = { queues: {
    "6.1": { enabled: true, chatIds: ["a"] },
    "6.2": { enabled: true, chats: [
      { chatId: "a", settings: { outageReminderBeforeMinutes: 0, scheduleImageEnabled: false } },
      { chatId: "b", settings: { changeSummaryProvider: "gemini" } }
    ] }
  } };
  const rows = parseSubscriptions(source);
  assert.deepEqual(rows.map(({ queue, subQueue, chatId }) => [queue, subQueue, chatId]),
    [[6, 1, "a"], [6, 2, "a"], [6, 2, "b"]]);
  assert.equal(rows[1].settings.scheduleImageEnabled, false);
  const normalized = normalizeSubscriptions(source);
  assert.deepEqual(normalized.queues["6.1"].chats, [{ chatId: "a", settings: {} }]);
  assert.deepEqual(parseSubscriptions(normalized), rows);
  assert.deepEqual(normalizeSubscriptions(normalized), normalized);
});

test("subscription settings reject invalid values and duplicate destinations", () => {
  const source = { queues: { "1.1": { enabled: true, chats: [
    { chatId: "a", settings: { outageReminderBeforeMinutes: 1441 } }
  ] } } };
  assert.throws(() => parseSubscriptions(source), /outageReminderBeforeMinutes/);
  source.queues["1.1"].chats[0].settings = { unknown: true };
  assert.throws(() => parseSubscriptions(source), /unknown/);
  source.queues["1.1"].chats[0].settings = {};
  source.queues["1.1"].chats.push({ chatId: "a" });
  assert.throws(() => parseSubscriptions(source), /Duplicate/);
  source.queues["1.1"].chatIds = ["a"];
  assert.throws(() => parseSubscriptions(source), /chats.*chatIds/);
});

test("legacy array converts to queue-keyed chats", () => {
  const normalized = normalizeSubscriptions({ subscriptions: [
    { queue: 2, subQueue: 1, chatId: "x" },
    { queue: 2, subQueue: 1, chatId: "y", settings: { pinTodaySchedule: false } }
  ] });
  assert.deepEqual(normalized.queues["2.1"].chats, [
    { chatId: "x", settings: {} },
    { chatId: "y", settings: { pinTodaySchedule: false } }
  ]);
});
