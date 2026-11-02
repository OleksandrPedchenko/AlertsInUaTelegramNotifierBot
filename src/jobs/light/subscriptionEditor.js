"use strict";

const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { isIP } = require("node:net");
const { createEnvReader } = require("../../lib/config");
const { loadLightConfig } = require("./config");
const { readSubscriptionDocument, saveSubscriptionDocument } = require("./subscriptionFile");
const { SETTING_FIELDS } = require("./subscriptions");

function isPrivateIpv4(address) {
  const parts = address.split(".").map(Number);
  return parts[0] === 10 || parts[0] === 192 && parts[1] === 168 ||
    parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31;
}

function selectHost(requested) {
  if (requested) {
    if (isIP(requested) !== 4 || !(isPrivateIpv4(requested) || requested === "127.0.0.1")) {
      throw new Error("--host must be a private IPv4 or 127.0.0.1 address");
    }
    return requested;
  }
  const addresses = [...new Set(Object.values(os.networkInterfaces()).flat()
    .filter(item => item?.family === "IPv4" && !item.internal && isPrivateIpv4(item.address))
    .map(item => item.address))];
  if (addresses.length !== 1) throw new Error("Specify --host with this machine's LAN IPv4 address");
  return addresses[0];
}

function parseArgs(args) {
  const options = { port: 3020 };
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (["--host", "--file", "--port"].includes(key) && args[index + 1]) {
      options[key.slice(2)] = args[++index];
    } else throw new Error(`Unknown or incomplete option: ${key}`);
  }
  options.port = Number(options.port);
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error("--port must be an integer from 1 to 65535");
  }
  return options;
}

function defaultsForEditor(filePath, env) {
  const source = { ...env, TG_BOT_TOKEN: env.TG_BOT_TOKEN || "editor-preview", LIGHT_SUBSCRIPTIONS_FILE: filePath };
  const config = loadLightConfig(source, createEnvReader(source, { cwd: path.dirname(filePath) }));
  return Object.fromEntries(Object.keys(SETTING_FIELDS).map(key => [key, config.job[key]]));
}

function sendJson(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(value));
}

async function discoverChats(filePath, botToken, fetchImpl = fetch) {
  if (!botToken) throw new Error("TG_BOT_TOKEN is missing from .env");
  async function telegram(method, body = {}) {
    const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10000)
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(`Telegram ${method}: ${payload.description || response.status}`);
    return payload.result;
  }
  const configured = await readSubscriptionDocument(filePath);
  const ids = new Set(Object.values(configured.normalized.queues)
    .flatMap(queue => queue.chats.map(chat => chat.chatId)));
  const me = await telegram("getMe");
  let notice = "";
  try {
    const updates = await telegram("getUpdates", { timeout: 0, limit: 100 });
    for (const update of updates) {
      const chat = update.my_chat_member?.chat || update.channel_post?.chat || update.message?.chat;
      if (chat && ["channel", "supergroup", "group"].includes(chat.type) &&
          !["left", "kicked"].includes(update.my_chat_member?.new_chat_member?.status)) {
        ids.add(String(chat.id));
      }
    }
  } catch {
    notice = "Recent Telegram updates are unavailable; showing configured chats only.";
  }
  const chats = [];
  for (const id of ids) {
    try {
      const member = await telegram("getChatMember", { chat_id: id, user_id: me.id });
      if (["left", "kicked"].includes(member.status)) continue;
      const chat = await telegram("getChat", { chat_id: id });
      if (["channel", "supergroup", "group"].includes(chat.type)) {
        chats.push({ id: String(chat.id), title: chat.title || String(chat.id), type: chat.type });
      }
    } catch { /* A configured chat may no longer be accessible to this bot. */ }
  }
  return { chats, notice };
}

async function readJsonBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1024 * 1024) throw new Error("Request is too large");
  }
  return JSON.parse(body);
}

function createEditorServer({ filePath, host, defaults, botToken, fetchImpl }) {
  return http.createServer(async (request, response) => {
    const expectedHost = `${host}:${request.socket.localPort}`;
    if (request.headers.host !== expectedHost) {
      sendJson(response, 403, { error: "Unexpected host" });
      return;
    }
    try {
      if (request.method === "GET" && request.url === "/") {
        const html = await fs.readFile(path.join(__dirname, "subscriptionEditor.html"));
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
        response.end(html);
      } else if (request.method === "GET" && request.url === "/api/subscriptions") {
        const document = await readSubscriptionDocument(filePath);
        sendJson(response, 200, { document: document.normalized, hash: document.hash, defaults, fields: SETTING_FIELDS });
      } else if (request.method === "GET" && request.url === "/api/chats") {
        sendJson(response, 200, await discoverChats(filePath, botToken, fetchImpl));
      } else if (request.method === "PUT" && request.url === "/api/subscriptions") {
        if (request.headers.origin !== `http://${expectedHost}` ||
            !request.headers["content-type"]?.startsWith("application/json")) {
          sendJson(response, 403, { error: "Save must come from this editor" });
          return;
        }
        const payload = await readJsonBody(request);
        if (typeof payload.hash !== "string" || !payload.hash) throw new Error("Missing file version");
        const saved = await saveSubscriptionDocument(filePath, payload.document, payload.hash);
        sendJson(response, 200, { document: saved.normalized, hash: saved.hash });
      } else {
        sendJson(response, 404, { error: "Not found" });
      }
    } catch (error) {
      const fileError = ["ENOENT", "EACCES", "EPERM", "EIO", "ENOSPC"].includes(error.code);
      sendJson(response, error.code === "CONFLICT" ? 409 : fileError ? 500 : 400,
        { error: fileError ? "Could not access the subscription file" : error.message });
    }
  });
}

async function main(args = process.argv.slice(2)) {
  require("dotenv").config({ quiet: true });
  const options = parseArgs(args);
  const filePath = path.resolve(options.file || process.env.LIGHT_SUBSCRIPTIONS_FILE || "light-subscriptions.json");
  await readSubscriptionDocument(filePath);
  const host = selectHost(options.host);
  const defaults = defaultsForEditor(filePath, process.env);
  const server = createEditorServer({ filePath, host, defaults, botToken: process.env.TG_BOT_TOKEN });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, resolve);
  });
  console.log(`Subscription editor: http://${host}:${options.port}/`);
  console.log("Anyone who can reach this address can edit subscriptions. Stop with Ctrl+C.");
}

if (require.main === module) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { createEditorServer, defaultsForEditor, parseArgs, selectHost };
