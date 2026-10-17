"use strict";

const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { readSubscriptionDocument } = require("./subscriptionFile");

function parseArgs(args) {
  const options = { write: false };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--write") options.write = true;
    else if (args[index] === "--file" && args[index + 1]) options.file = args[++index];
    else throw new Error(`Unknown or incomplete option: ${args[index]}`);
  }
  return options;
}

async function main(args = process.argv.slice(2)) {
  require("dotenv").config({ quiet: true });
  const options = parseArgs(args);
  const filePath = path.resolve(options.file || process.env.LIGHT_SUBSCRIPTIONS_FILE || "light-subscriptions.json");
  const document = await readSubscriptionDocument(filePath);
  const queues = Object.fromEntries(Object.entries(document.normalized.queues).map(([key, entry]) => [
    key, { enabled: entry.enabled, chatIds: entry.chats.map(chat => chat.chatId) }
  ]));
  const formatted = `${JSON.stringify({ queues }, null, 2)}\n`;
  const count = Object.values(queues).reduce((total, entry) => total + (entry.enabled ? entry.chatIds.length : 0), 0);
  if (!options.write) {
    process.stdout.write(formatted);
    console.error(`Preview: ${count} enabled destinations. Add --write to save.`);
    return;
  }

  const current = await fs.readFile(filePath, "utf8");
  if (createHash("sha256").update(current).digest("hex") !== document.hash) {
    throw new Error("Subscription file changed since it was loaded");
  }
  const backupPath = `${filePath}.new-format.${randomUUID()}.bak`;
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  const mode = (await fs.stat(filePath)).mode & 0o777;
  try {
    await fs.copyFile(filePath, backupPath, fs.constants.COPYFILE_EXCL);
    await fs.writeFile(tempPath, formatted, { mode, flag: "wx" });
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.rm(tempPath, { force: true });
  }
  console.log(`Converted ${count} enabled destinations in ${filePath}; backup: ${backupPath}`);
}

if (require.main === module) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { parseArgs, main };
