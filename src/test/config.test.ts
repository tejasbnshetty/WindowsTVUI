import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { migrateLegacyData, prepareConfig } from "../config";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tvui-cfg-"));
const write = (p: string, text: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };

test("development: the project's own config.json is used in place, nothing is copied", () => {
  const root = tmp();
  const bundled = path.join(root, "config.json");
  write(bundled, '{"port":1}');
  const userData = path.join(root, "appdata");
  assert.equal(prepareConfig({ packaged: false, bundledConfig: bundled, userData }), bundled);
  assert.ok(!fs.existsSync(userData), "no app-data folder is created in development");
});

test("packaged: first run seeds a writable config.json in app data from the bundled default", () => {
  const root = tmp();
  const bundled = path.join(root, "asar", "config.json");
  write(bundled, '{"port":8787,"tiles":[]}');
  const userData = path.join(root, "Couch UI");
  const used = prepareConfig({ packaged: true, bundledConfig: bundled, userData });
  assert.equal(used, path.join(userData, "config.json"));
  assert.equal(fs.readFileSync(used, "utf8"), '{"port":8787,"tiles":[]}');
});

test("packaged: the user's edits are never overwritten by a later start or an update", () => {
  const root = tmp();
  const bundled = path.join(root, "config.json");
  write(bundled, '{"port":8787}');
  const userData = path.join(root, "Couch UI");
  const used = prepareConfig({ packaged: true, bundledConfig: bundled, userData });
  fs.writeFileSync(used, '{"port":9999,"tiles":["mine"]}');
  write(bundled, '{"port":1111}'); // a newer version ships a different default
  prepareConfig({ packaged: true, bundledConfig: bundled, userData });
  assert.equal(fs.readFileSync(used, "utf8"), '{"port":9999,"tiles":["mine"]}');
});

test("migrateLegacyData copies devices.json and settings.json once, into an empty new folder", () => {
  const root = tmp();
  const legacy = path.join(root, "windows-tv-ui");
  const fresh = path.join(root, "Couch UI");
  write(path.join(legacy, "devices.json"), "DEVICES");
  write(path.join(legacy, "settings.json"), "SETTINGS");
  write(path.join(legacy, "other.txt"), "IGNORED");
  assert.deepEqual(migrateLegacyData(fresh, legacy).sort(), ["devices.json", "settings.json"]);
  assert.equal(fs.readFileSync(path.join(fresh, "devices.json"), "utf8"), "DEVICES");
  assert.ok(!fs.existsSync(path.join(fresh, "other.txt")), "only the known files are carried over");
  assert.ok(fs.existsSync(path.join(legacy, "devices.json")), "the old folder is left alone");
});

test("migrateLegacyData never overwrites existing data", () => {
  const root = tmp();
  const legacy = path.join(root, "windows-tv-ui");
  const fresh = path.join(root, "Couch UI");
  write(path.join(legacy, "devices.json"), "OLD");
  write(path.join(fresh, "devices.json"), "NEW");
  assert.deepEqual(migrateLegacyData(fresh, legacy), []);
  assert.equal(fs.readFileSync(path.join(fresh, "devices.json"), "utf8"), "NEW");
});

test("migrateLegacyData: missing legacy folder, or the same folder, is a harmless no-op", () => {
  const root = tmp();
  assert.deepEqual(migrateLegacyData(path.join(root, "a"), path.join(root, "nope")), []);
  write(path.join(root, "same", "devices.json"), "X");
  assert.deepEqual(migrateLegacyData(path.join(root, "same"), path.join(root, "same")), []);
});
