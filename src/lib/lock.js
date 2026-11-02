"use strict";

const fs = require("fs/promises");

async function tryCreateLock(lockFilePath) {
  let handle;
  try {
    handle = await fs.open(lockFilePath, "wx", 0o600);
    await handle.writeFile(String(process.pid));
    return async () => {
      try {
        await handle.close();
      } finally {
        await fs.unlink(lockFilePath);
      }
    };
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } finally {
        await fs.unlink(lockFilePath);
      }
    }
    if (error.code === "EEXIST") return null;
    throw error;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

async function acquireRunLock(lockFilePath) {
  const release = await tryCreateLock(lockFilePath);
  if (release) return release;

  const currentOwner = await fs.readFile(lockFilePath, "utf8").catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const currentPid = Number(currentOwner);
  if (currentOwner && Number.isInteger(currentPid) && currentPid > 0 && isProcessAlive(currentPid)) {
    return null;
  }

  const recoveryPath = `${lockFilePath}.recovery`;
  let recovery;
  try {
    recovery = await fs.open(recoveryPath, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const stat = await fs.stat(recoveryPath).catch(statError => {
      if (statError.code === "ENOENT") return null;
      throw statError;
    });
    if (stat && Date.now() - stat.mtimeMs > 5000) {
      throw new Error(`Stale lock recovery guard '${recoveryPath}' requires removal`);
    }
    return null;
  }

  try {
    await recovery.writeFile(String(process.pid));
    const ownerText = await fs.readFile(lockFilePath, "utf8").catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (ownerText === null) return await tryCreateLock(lockFilePath);
    const owner = Number(ownerText);
    if (!ownerText.trim() || !Number.isInteger(owner) || owner <= 0) {
      throw new Error(`Invalid lock owner in '${lockFilePath}'`);
    }
    if (isProcessAlive(owner)) return null;
    await fs.unlink(lockFilePath).catch(error => {
      if (error.code !== "ENOENT") throw error;
    });
    return await tryCreateLock(lockFilePath);
  } finally {
    try {
      await recovery.close();
    } finally {
      await fs.unlink(recoveryPath);
    }
  }
}

module.exports = {
  acquireRunLock
};
