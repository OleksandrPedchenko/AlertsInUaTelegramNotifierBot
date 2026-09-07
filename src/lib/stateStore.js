"use strict";

const fs = require("fs/promises");
const path = require("path");

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readJsonFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT" || error.name === "SyntaxError") {
      return null;
    }

    throw error;
  }
}

function normalizeStore(candidate) {
  if (!isObject(candidate) || !isObject(candidate.records)) {
    return {
      version: 1,
      records: {}
    };
  }

  return {
    version: 1,
    records: candidate.records
  };
}

async function readJobState(filePath, stateKey) {
  const parsed = await readJsonFile(filePath);
  if (!parsed) {
    return null;
  }

  if (isObject(parsed.records)) {
    const record = parsed.records[stateKey];
    return isObject(record) ? record : null;
  }

  if (isObject(parsed)) {
    return {
      stateKey,
      fingerprint: parsed.fingerprint || null,
      state: parsed.state || parsed,
      updatedAt: parsed.updatedAt || null,
      legacy: true
    };
  }

  return null;
}

async function writeJobState(filePath, stateKey, state, fingerprint, metadata = {}) {
  if (!stateKey || typeof stateKey !== "string") {
    throw new Error("stateKey must be a non-empty string");
  }

  const parsed = await readJsonFile(filePath);
  const store = normalizeStore(parsed);

  store.records[stateKey] = {
    stateKey,
    fingerprint,
    state,
    metadata,
    updatedAt: new Date().toISOString()
  };

  const dirPath = path.dirname(filePath);
  await fs.mkdir(dirPath, { recursive: true });

  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify(store, null, 2);

  try {
    await fs.writeFile(tmpPath, `${payload}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

module.exports = {
  readJobState,
  writeJobState
};
