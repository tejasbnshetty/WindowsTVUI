import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createFileDeviceStore, createMemoryDeviceStore, deviceLabel, hashToken } from "../devices";
import { createSettingsStore } from "../settings";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tvui-test-"));
const token = "ab".repeat(32);
const info = (t = token, label = "iPhone") => ({ hash: hashToken(t), label, createdAt: 1 });

test("hashToken is a stable SHA-256 hex digest", () => {
  assert.equal(hashToken("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("device store: add / has / count / clear in memory", () => {
  const s = createMemoryDeviceStore();
  assert.equal(s.count(), 0);
  s.add(info());
  assert.ok(s.has(hashToken(token)));
  assert.ok(!s.has(hashToken("other")));
  assert.equal(s.count(), 1);
  s.clear();
  assert.equal(s.count(), 0);
});

test("file device store persists across instances, stores only the hash, never the token", () => {
  const file = path.join(tmp(), "nested", "devices.json");
  const a = createFileDeviceStore(file);
  a.add(info());
  const onDisk = fs.readFileSync(file, "utf8");
  assert.ok(onDisk.includes(hashToken(token)), "hash is on disk");
  assert.ok(!onDisk.includes(token), "the raw token is NOT on disk");

  const b = createFileDeviceStore(file); // simulates an app restart
  assert.equal(b.count(), 1);
  assert.ok(b.has(hashToken(token)));
});

test("clearing persists too (forget all devices survives a restart)", () => {
  const file = path.join(tmp(), "devices.json");
  const a = createFileDeviceStore(file);
  a.add(info());
  a.clear();
  assert.equal(createFileDeviceStore(file).count(), 0);
});

test("a corrupt devices file fails closed: no devices, file kept aside, no crash", () => {
  const dir = tmp();
  const file = path.join(dir, "devices.json");
  fs.writeFileSync(file, "{ not json");
  const warn = console.warn;
  console.warn = () => {};
  try {
    const s = createFileDeviceStore(file);
    assert.equal(s.count(), 0);
  } finally {
    console.warn = warn;
  }
  assert.ok(fs.existsSync(`${file}.corrupt`));
});

test("entries with malformed hashes are dropped on load", () => {
  const file = path.join(tmp(), "devices.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, devices: [info(), { hash: "short", label: "x", createdAt: 1 }, 5, null] }));
  assert.equal(createFileDeviceStore(file).count(), 1);
});

test("a BOM at the start of the file is tolerated", () => {
  const file = path.join(tmp(), "devices.json");
  fs.writeFileSync(file, "﻿" + JSON.stringify({ version: 1, devices: [info()] }));
  assert.equal(createFileDeviceStore(file).count(), 1);
});

test("an unwritable location does not throw (pairing still works for the session)", () => {
  const dir = tmp();
  const blocker = path.join(dir, "file-not-dir");
  fs.writeFileSync(blocker, "x");
  const s = createFileDeviceStore(path.join(blocker, "devices.json")); // parent is a file: mkdir fails
  const err = console.error;
  console.error = () => {};
  try {
    assert.doesNotThrow(() => s.add(info()));
  } finally {
    console.error = err;
  }
  assert.ok(s.has(hashToken(token)));
});

test("deviceLabel", () => {
  assert.equal(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"), "iPhone");
  assert.equal(deviceLabel("Mozilla/5.0 (Linux; Android 14)"), "Android phone");
  assert.equal(deviceLabel(undefined), "Browser");
});

test("settings store: default, save, reload, reset, corrupt file", () => {
  const dir = tmp();
  const file = path.join(dir, "settings.json");
  const a = createSettingsStore(file);
  assert.equal(a.get().display, null);
  a.setDisplay({ id: 42, label: "TV", width: 1920, height: 1080 });
  assert.deepEqual(createSettingsStore(file).get().display, { id: 42, label: "TV", width: 1920, height: 1080 });
  a.setDisplay(null);
  assert.equal(createSettingsStore(file).get().display, null);
  fs.writeFileSync(file, "garbage");
  assert.equal(createSettingsStore(file).get().display, null);
  fs.writeFileSync(file, JSON.stringify({ display: { id: "nope" } }));
  assert.equal(createSettingsStore(file).get().display, null, "invalid shape ignored");
});
