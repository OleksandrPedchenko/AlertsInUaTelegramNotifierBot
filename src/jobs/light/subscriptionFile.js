"use strict";

const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { normalizeSubscriptions } = require("./subscriptions");

function fileHash(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function readSubscriptionDocument(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  const data = JSON.parse(text);
  return { data, normalized: normalizeSubscriptions(data), hash: fileHash(text) };
}

async function saveSubscriptionDocument(filePath, data, expectedHash) {
  const normalized = normalizeSubscriptions(data);
  const current = await fs.readFile(filePath, "utf8");
  if (expectedHash && fileHash(current) !== expectedHash) {
    const error = new Error("Subscription file changed since it was loaded");
    error.code = "CONFLICT";
    throw error;
  }
  const formatted = `${JSON.stringify(normalized, null, 2)}\n`;
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    const mode = (await fs.stat(filePath)).mode & 0o777;
    await fs.writeFile(tempPath, formatted, { mode, flag: "wx" });
    await fs.copyFile(filePath, `${filePath}.bak`);
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.rm(tempPath, { force: true });
  }
  return { normalized, hash: fileHash(formatted) };
}

module.exports = { readSubscriptionDocument, saveSubscriptionDocument };
