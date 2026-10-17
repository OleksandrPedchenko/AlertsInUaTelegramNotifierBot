"use strict";

const path = require("node:path");
const { readSubscriptionDocument, saveSubscriptionDocument } = require("./subscriptionFile");

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
  const count = Object.values(document.normalized.queues)
    .reduce((total, entry) => total + (entry.enabled ? entry.chats.length : 0), 0);
  if (options.write) {
    await saveSubscriptionDocument(filePath, document.normalized, document.hash, { requireEnabled: false });
    console.log(`Converted ${count} enabled destinations in ${filePath}; backup: ${filePath}.bak`);
  } else {
    console.log(JSON.stringify(document.normalized, null, 2));
    console.error(`Preview: ${count} enabled destinations. Add --write to save.`);
  }
}

if (require.main === module) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { parseArgs, main };
