"use strict";

const fs = require("fs/promises");

async function acquireRunLock(lockFilePath) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
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
        await handle.close();
        await fs.unlink(lockFilePath);
      }
      if (error.code !== "EEXIST") throw error;
      const ownerText = await fs.readFile(lockFilePath, "utf8").catch(readError => {
        if (readError.code === "ENOENT") return null;
        throw readError;
      });
      if (ownerText === null) continue;
      const owner = Number(ownerText);
      if (!ownerText.trim() || !Number.isInteger(owner) || owner <= 0) {
        throw new Error(`Invalid lock owner in '${lockFilePath}'`);
      }
      try {
        process.kill(owner, 0);
        return null;
      } catch (checkError) {
        if (checkError.code !== "ESRCH") return null;
      }
      if (attempt === 0) {
        await fs.unlink(lockFilePath).catch(unlinkError => {
          if (unlinkError.code !== "ENOENT") throw unlinkError;
        });
      }
    }
  }
  return null;
}

module.exports = {
  acquireRunLock
};
