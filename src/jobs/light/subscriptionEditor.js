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

async function readJsonBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1024 * 1024) throw new Error("Request is too large");
  }
  return JSON.parse(body);
}

function createEditorServer({ filePath, host, defaults }) {
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
  const server = createEditorServer({ filePath, host, defaults });
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
