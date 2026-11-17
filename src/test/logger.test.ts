import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createLogger } from "../logger";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tvui-log-"));
const files = (dir: string) => fs.readdirSync(dir).sort();

test("writes timestamped, levelled lines to couch-ui.log", () => {
  const dir = tmp();
  const log = createLogger({ dir, now: () => new Date("2026-11-17T12:00:00.000Z") });
  log.log("info", "hello");
  log.log("error", "boom");
  assert.equal(fs.readFileSync(log.file(), "utf8"), "2026-11-17T12:00:00.000Z [info] hello\n2026-11-17T12:00:00.000Z [error] boom\n");
  assert.equal(path.basename(log.file()), "couch-ui.log");
});

test("creates the log directory if it does not exist", () => {
  const dir = path.join(tmp(), "a", "b", "logs");
  const log = createLogger({ dir });
  log.log("info", "x");
  assert.ok(fs.existsSync(path.join(dir, "couch-ui.log")));
});

test("rotates when a file would exceed maxBytes, and no file ever exceeds it", () => {
  const dir = tmp();
  const log = createLogger({ dir, maxBytes: 1000, maxFiles: 5 });
  for (let i = 0; i < 100; i++) log.log("info", `line ${i} ${"x".repeat(60)}`);
  for (const f of files(dir)) assert.ok(fs.statSync(path.join(dir, f)).size <= 1000, `${f} is ${fs.statSync(path.join(dir, f)).size} bytes`);
  assert.deepEqual(files(dir), ["couch-ui.1.log", "couch-ui.2.log", "couch-ui.3.log", "couch-ui.4.log", "couch-ui.log"]);
});

test("keeps only the LAST 5 files in total (current + 4 older), dropping the oldest", () => {
  const dir = tmp();
  const log = createLogger({ dir, maxBytes: 500, maxFiles: 5 });
  for (let i = 0; i < 400; i++) log.log("info", `entry-${String(i).padStart(4, "0")} ${"y".repeat(40)}`);
  assert.equal(files(dir).length, 5);
  const all = files(dir).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("");
  assert.ok(all.includes("entry-0399"), "the newest entry is kept");
  assert.ok(!all.includes("entry-0000"), "the oldest entries have been dropped");
  // order: .log is newest, .4.log oldest
  const newest = fs.readFileSync(path.join(dir, "couch-ui.log"), "utf8");
  const oldest = fs.readFileSync(path.join(dir, "couch-ui.4.log"), "utf8");
  assert.ok(Number(/entry-(\d{4})/.exec(newest)![1]) > Number(/entry-(\d{4})/.exec(oldest)![1]));
});

test("the default limits are 1 MB per file and 5 files", () => {
  const dir = tmp();
  const log = createLogger({ dir });
  const line = "z".repeat(3000);
  for (let i = 0; i < 2000; i++) log.log("info", line); // ~6 MB
  assert.ok(files(dir).length <= 5);
  for (const f of files(dir)) assert.ok(fs.statSync(path.join(dir, f)).size <= 1024 * 1024, f);
});

test("an existing log is appended to (size is picked up after a restart) and rotated on schedule", () => {
  const dir = tmp();
  const a = createLogger({ dir, maxBytes: 400 });
  a.log("info", "first run " + "a".repeat(100));
  const b = createLogger({ dir, maxBytes: 400 }); // restart
  for (let i = 0; i < 6; i++) b.log("info", "second run " + "b".repeat(100));
  assert.ok(files(dir).includes("couch-ui.1.log"), "rotated even though part of the file came from the previous run");
  for (const f of files(dir)) assert.ok(fs.statSync(path.join(dir, f)).size <= 400);
});

test("a single huge message is truncated so it cannot blow the size limit", () => {
  const dir = tmp();
  const log = createLogger({ dir, maxBytes: 10_000 });
  log.log("error", "q".repeat(1_000_000));
  const size = fs.statSync(log.file()).size;
  assert.ok(size < 5000, `size ${size}`);
  assert.match(fs.readFileSync(log.file(), "utf8"), /\[truncated\]/);
});

test("multi-line messages stay on indented continuation lines", () => {
  const dir = tmp();
  const log = createLogger({ dir, now: () => new Date(0) });
  log.log("error", "Error: boom\n    at x\n    at y");
  const lines = fs.readFileSync(log.file(), "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith("1970-01-01T00:00:00.000Z [error] Error: boom"));
});

test("logging NEVER throws, even into an unusable location", () => {
  const dir = tmp();
  const blocker = path.join(dir, "not-a-dir");
  fs.writeFileSync(blocker, "x");
  const log = createLogger({ dir: path.join(blocker, "logs") });
  assert.doesNotThrow(() => log.log("info", "still fine"));
  assert.doesNotThrow(() => log.log("error", "still fine"));
});

test("installConsole mirrors console.* into the file while keeping normal output", () => {
  const dir = tmp();
  const log = createLogger({ dir, now: () => new Date(0) });
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const shown: string[] = [];
  console.log = (...a: unknown[]) => { shown.push(a.join(" ")); };
  console.info = console.log; console.warn = console.log; console.error = console.log;
  try {
    log.installConsole();
    console.log("a %s b", "X");
    console.warn("careful");
    console.error(new Error("kaboom").message, { code: 7 });
  } finally {
    Object.assign(console, saved);
  }
  assert.equal(shown.length, 3, "the original console output still happens");
  const text = fs.readFileSync(log.file(), "utf8");
  assert.match(text, /\[info\] a X b/);
  assert.match(text, /\[warn\] careful/);
  assert.match(text, /\[error\] kaboom \{ code: 7 \}/);
});

test("maxFiles=1 keeps a single file", () => {
  const dir = tmp();
  const log = createLogger({ dir, maxBytes: 300, maxFiles: 1 });
  for (let i = 0; i < 50; i++) log.log("info", "m".repeat(80));
  assert.deepEqual(files(dir), ["couch-ui.log"]);
});
