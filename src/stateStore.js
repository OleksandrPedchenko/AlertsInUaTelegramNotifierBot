"use strict";

const fs = require("fs/promises");
const path = require("path");

const ALERT_STATES = new Set(["N", "A", "P"]);

function normalizeStateRecord(candidate) {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const regionId = Number(candidate.regionId);
  const alertState = String(candidate.alertState || "").trim().toUpperCase();
  const lastModified = candidate.lastModified ? String(candidate.lastModified).trim() : null;

  if (!Number.isInteger(regionId) || regionId < 1) {
    return null;
  }

  if (!ALERT_STATES.has(alertState)) {
    return null;
  }

  return {
    regionId,
    alertState,
    lastModified
  };
}

async function readLastState(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return normalizeStateRecord(parsed);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    if (error.name === "SyntaxError") {
      return null;
    }

    throw error;
  }
}

async function writeLastState(filePath, state) {
  const normalized = normalizeStateRecord(state);
  if (!normalized) {
    throw new Error("Cannot persist invalid alert state record");
  }

  const dirPath = path.dirname(filePath);
  await fs.mkdir(dirPath, { recursive: true });

  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const payloadObj = {
    ...normalized,
    updatedAt: new Date().toISOString()
  };

  if (normalized.lastModified) {
    payloadObj.lastModified = normalized.lastModified;
  }

  const payload = JSON.stringify(payloadObj, null, 2);

  try {
    await fs.writeFile(tmpPath, `${payload}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

module.exports = {
  readLastState,
  writeLastState
};
