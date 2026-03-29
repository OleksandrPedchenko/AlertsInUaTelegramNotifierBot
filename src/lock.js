"use strict";

const fs = require("fs/promises");

async function acquireRunLock(lockFilePath) {
  try {
    const handle = await fs.open(lockFilePath, "wx", 0o600);
    await handle.writeFile(String(process.pid));

    return async () => {
      await handle.close();
      await fs.unlink(lockFilePath).catch(() => undefined);
    };
  } catch (error) {
    if (error.code === "EEXIST") {
      return null;
    }

    throw error;
  }
}

module.exports = {
  acquireRunLock
};
