"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { createLogger } = require("../src/lib/logger");

const silent = { log() {}, error() {} };

test("logger initializes and rotates a 100 MB file without reading its contents", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logger-large-"));
  try {
    const file = path.join(dir, "app.log");
    fs.closeSync(fs.openSync(file, "w"));
    fs.truncateSync(file, 100 * 1024 * 1024);
    const originalRead = fs.readFileSync;
    fs.readFileSync = () => { throw new Error("full file read"); };
    try {
      const logger = createLogger({ logFilePath: file, maxFileBytes: 10 * 1024 * 1024, consoleWriter: silent });
      logger.info("after rotation");
    } finally {
      fs.readFileSync = originalRead;
    }
    assert.match(fs.readFileSync(file, "utf8"), /after rotation/);
    assert.ok(fs.readdirSync(dir).some(name => name.startsWith("app.log.") && name.endsWith(".log")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("logger keeps a bounded number of archives and expires old ones", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logger-retention-"));
  try {
    const file = path.join(dir, "app.log");
    for (let i = 0; i < 5; i++) {
      const archive = `${file}.${Date.now() - (i + 1) * 86400000}-123-00000000-0000-4000-8000-${String(i).padStart(12, "0")}.log`;
      fs.writeFileSync(archive, String(i));
      const then = new Date(Date.now() - (i + 1) * 86400000);
      fs.utimesSync(archive, then, then);
    }
    const logger = createLogger({ logFilePath: file, retentionDays: 3, maxFiles: 2, consoleWriter: silent });
    logger.info("new");
    const archives = fs.readdirSync(dir).filter(name => name !== "app.log");
    assert.equal(archives.length, 2);
    assert.deepEqual(archives.map(name => fs.readFileSync(path.join(dir, name), "utf8")).sort(), ["0", "1"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("logger rotates before the next entry crosses the size limit", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logger-size-"));
  try {
    const file = path.join(dir, "app.log");
    const logger = createLogger({ logFilePath: file, maxFileBytes: 180, consoleWriter: silent });
    for (let i = 0; i < 8; i++) logger.info("entry", { i });
    const files = fs.readdirSync(dir);
    assert.ok(files.length > 1);
    assert.ok(files.every(name => fs.statSync(path.join(dir, name)).size <= 180));
    assert.equal(files.flatMap(name => fs.readFileSync(path.join(dir, name), "utf8").trim().split("\n").filter(Boolean)).length, 8);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("overlapping processes retain complete JSON lines across rotations", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logger-concurrent-"));
  try {
    const file = path.join(dir, "app.log");
    const modulePath = require.resolve("../src/lib/logger");
    const worker = `const {createLogger}=require(${JSON.stringify(modulePath)}); const l=createLogger({logFilePath:process.argv[1],maxFileBytes:2048,retentionDays:7,consoleWriter:{log(){},error(){}}}); for(let i=0;i<100;i++) l.info('entry',{worker:process.argv[2],i});`;
    await Promise.all(Array.from({ length: 4 }, (_, i) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", worker, file, String(i)]);
      child.on("error", reject);
      child.on("exit", code => code === 0 ? resolve() : reject(new Error(`worker exited ${code}`)));
    })));
    const entries = fs.readdirSync(dir).flatMap(name => fs.readFileSync(path.join(dir, name), "utf8")
      .trim().split("\n").filter(Boolean).map(JSON.parse));
    assert.equal(entries.length, 400);
    assert.equal(new Set(entries.map(entry => `${entry.worker}:${entry.i}`)).size, 400);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a freshly rotated old file survives another logger's cleanup", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logger-grace-"));
  try {
    const file = path.join(dir, "app.log");
    fs.writeFileSync(file, "old\n".repeat(100));
    const old = new Date(Date.now() - 10 * 86400000);
    fs.utimesSync(file, old, old);
    createLogger({ logFilePath: file, maxFileBytes: 100, retentionDays: 1, consoleWriter: silent });
    createLogger({ logFilePath: file, maxFileBytes: 100, retentionDays: 1, consoleWriter: silent });
    assert.equal(fs.readdirSync(dir).filter(name => name.startsWith("app.log.")).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanup preserves unrelated files with a similar name", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logger-unrelated-"));
  try {
    const file = path.join(dir, "app.log");
    const backup = `${file}.backup.log`;
    fs.writeFileSync(backup, "backup");
    const old = new Date(Date.now() - 10 * 86400000);
    fs.utimesSync(backup, old, old);
    createLogger({ logFilePath: file, retentionDays: 1, consoleWriter: silent });
    assert.equal(fs.readFileSync(backup, "utf8"), "backup");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("zero retention preserves rotated files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logger-no-retention-"));
  try {
    const file = path.join(dir, "app.log");
    const old = new Date(Date.now() - 10 * 86400000);
    const archives = [0, 1].map(i => `${file}.${Date.now() - (10 + i) * 86400000}-123-00000000-0000-4000-8000-${String(i).padStart(12, "0")}.log`);
    for (const archive of archives) {
      fs.writeFileSync(archive, "old");
      fs.utimesSync(archive, old, old);
    }
    createLogger({ logFilePath: file, retentionDays: 0, maxFiles: 1, consoleWriter: silent });
    assert.ok(archives.every(archive => fs.readFileSync(archive, "utf8") === "old"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
