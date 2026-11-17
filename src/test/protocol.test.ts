import { test } from "node:test";
import * as assert from "node:assert/strict";
import { KEY_NAMES, MAX_MOVE, MAX_SCROLL, parseCommand } from "../protocol";

const parse = (json: string) => parseCommand(JSON.parse(json));

test("accepts every documented valid message", () => {
  const valid: Array<[string, unknown]> = [
    [`{"type":"nav","action":"up"}`, { type: "nav", action: "up" }],
    [`{"type":"nav","action":"home"}`, { type: "nav", action: "home" }],
    [`{"type":"mouse_move","dx":5,"dy":-3}`, { type: "mouse_move", dx: 5, dy: -3 }],
    [`{"type":"mouse_click","button":"right"}`, { type: "mouse_click", button: "right" }],
    [`{"type":"mouse_down","button":"left"}`, { type: "mouse_down", button: "left" }],
    [`{"type":"mouse_up","button":"middle"}`, { type: "mouse_up", button: "middle" }],
    [`{"type":"scroll","dx":0,"dy":120}`, { type: "scroll", dx: 0, dy: 120 }],
    [`{"type":"key","key":"Enter"}`, { type: "key", key: "Enter" }],
    [`{"type":"text","value":"héllo ✓ 😀"}`, { type: "text", value: "héllo ✓ 😀" }],
    [`{"type":"media","action":"play_pause"}`, { type: "media", action: "play_pause" }],
  ];
  for (const [json, expected] of valid) assert.deepEqual(parse(json), expected, json);
});

test("every whitelisted key is accepted, nothing else is", () => {
  for (const key of KEY_NAMES) assert.deepEqual(parseCommand({ type: "key", key }), { type: "key", key });
  for (const key of ["F4", "Alt+F4", "Ctrl+Alt+Delete", "Meta", "Win+R", "Ctrl+C", "Delete", "Space", "enter", "Alt+Tab", "", "constructor", "__proto__"]) {
    assert.equal(parseCommand({ type: "key", key }), null, `key ${key}`);
  }
});

test("rejects unknown types and malformed envelopes", () => {
  const bad: unknown[] = [
    null, undefined, 1, "x", true, [], [{ type: "nav", action: "up" }],
    {}, { type: 1 }, { type: null }, { type: "" }, { type: "exec", cmd: "calc" }, { type: "shell" },
    { type: "toString" }, { type: "constructor" }, { type: "__proto__" }, { type: "NAV", action: "up" },
    { type: "mouse_move" }, { type: "key" }, { type: "text" }, { type: "media" }, { type: "nav" },
  ];
  for (const m of bad) assert.equal(parseCommand(m), null, JSON.stringify(m));
});

test("rejects unknown actions / buttons / media names", () => {
  assert.equal(parseCommand({ type: "nav", action: "explode" }), null);
  assert.equal(parseCommand({ type: "nav", action: ["up"] }), null);
  assert.equal(parseCommand({ type: "nav", action: "__proto__" }), null);
  assert.equal(parseCommand({ type: "mouse_click", button: "back" }), null);
  assert.equal(parseCommand({ type: "mouse_click", button: 1 }), null);
  assert.equal(parseCommand({ type: "mouse_down", button: "LEFT" }), null);
  assert.equal(parseCommand({ type: "media", action: "eject" }), null);
  assert.equal(parseCommand({ type: "media", action: "power" }), null);
});

test("numeric values are validated, rounded and clamped", () => {
  assert.deepEqual(parseCommand({ type: "mouse_move", dx: 99999, dy: -99999 }), { type: "mouse_move", dx: MAX_MOVE, dy: -MAX_MOVE });
  assert.deepEqual(parseCommand({ type: "scroll", dx: 1e9, dy: -1e9 }), { type: "scroll", dx: MAX_SCROLL, dy: -MAX_SCROLL });
  assert.deepEqual(parseCommand({ type: "mouse_move", dx: 1.6, dy: -2.4 }), { type: "mouse_move", dx: 2, dy: -2 });
  for (const v of [NaN, Infinity, -Infinity, "5", null, undefined, {}, [], true]) {
    assert.equal(parseCommand({ type: "mouse_move", dx: v, dy: 1 }), null, String(v));
    assert.equal(parseCommand({ type: "scroll", dx: 1, dy: v }), null, String(v));
  }
  assert.equal(parseCommand({ type: "mouse_move", dx: 0, dy: 0 }), null, "no-op moves are dropped");
  assert.equal(parseCommand({ type: "mouse_move", dx: 0.2, dy: -0.2 }), null, "rounds to no-op");
});

test("text: length limit, control characters, types", () => {
  assert.notEqual(parseCommand({ type: "text", value: "a".repeat(200) }), null);
  assert.equal(parseCommand({ type: "text", value: "a".repeat(201) }), null);
  assert.equal(parseCommand({ type: "text", value: "" }), null);
  for (const v of ["a\nb", "a\rb", "a\tb", "\u0000", "\u001b[A", "x\u007f", "\u0085", 5, null, ["a"], { a: 1 }]) {
    assert.equal(parseCommand({ type: "text", value: v }), null, JSON.stringify(v));
  }
});

test("extra fields never leak into the parsed command", () => {
  const cmd = parseCommand({ type: "key", key: "Enter", vk: 91, flags: 1, cmd: "calc.exe" });
  assert.deepEqual(cmd, { type: "key", key: "Enter" });
  const cmd2 = parseCommand(JSON.parse(`{"type":"nav","action":"ok","__proto__":{"polluted":true}}`));
  assert.deepEqual(cmd2, { type: "nav", action: "ok" });
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("M4 commands: app / display_set / forget_devices / pair_new", () => {
  assert.deepEqual(parseCommand({ type: "app", action: "close" }), { type: "app", action: "close" });
  assert.deepEqual(parseCommand({ type: "app", action: "switch" }), { type: "app", action: "switch" });
  for (const a of ["quit", "kill", "Close", "", 1, null, ["close"]]) assert.equal(parseCommand({ type: "app", action: a }), null, String(a));

  assert.deepEqual(parseCommand({ type: "display_set", id: 2779098405 }), { type: "display_set", id: 2779098405 });
  assert.deepEqual(parseCommand({ type: "display_set", id: null }), { type: "display_set", id: null });
  for (const id of ["1", 1.5, NaN, Infinity, 2 ** 60, {}, [], true, undefined]) {
    assert.equal(parseCommand({ type: "display_set", id }), null, String(id));
  }

  assert.deepEqual(parseCommand({ type: "forget_devices", extra: "x" }), { type: "forget_devices" });
  assert.deepEqual(parseCommand({ type: "pair_new", pin: "123456" }), { type: "pair_new" });
});

test("Alt+F4 / Alt+Tab cannot be sent as plain keys", () => {
  for (const key of ["Alt+F4", "Alt+Tab", "Win+D", "Ctrl+Alt+Delete"]) assert.equal(parseCommand({ type: "key", key }), null, key);
});

test("M5 command: exit_app takes no arguments", () => {
  assert.deepEqual(parseCommand({ type: "exit_app" }), { type: "exit_app" });
  assert.deepEqual(parseCommand({ type: "exit_app", force: true, code: 1 }), { type: "exit_app" });
});
