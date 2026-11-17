import { test } from "node:test";
import * as assert from "node:assert/strict";
import { InputBackend, KEY_TABLE, RawInput, VK, createInput } from "../input";
import { KEY_NAMES, parseCommand } from "../protocol";
import { dispatchInput } from "../dispatch";

function mock(accept?: (n: number) => number) {
  const calls: RawInput[][] = [];
  const backend: InputBackend = {
    sendInput(inputs) {
      calls.push(inputs);
      return accept ? accept(inputs.length) : inputs.length;
    },
  };
  return { calls, input: createInput(backend) };
}

const M = (flags: number, dx = 0, dy = 0, mouseData = 0): RawInput => ({ kind: "mouse", dx, dy, mouseData, flags });
const K = (vk: number, flags: number, scan = 0): RawInput => ({ kind: "key", vk, scan, flags });

test("moveRelative sends one relative MOVE event", () => {
  const { calls, input } = mock();
  input.moveRelative(5, -3);
  assert.deepEqual(calls, [[M(0x0001, 5, -3)]]);
});

test("moveRelative(0,0) sends nothing", () => {
  const { calls, input } = mock();
  input.moveRelative(0, 0);
  assert.equal(calls.length, 0);
});

test("click = down+up in a single atomic call, per button", () => {
  const { calls, input } = mock();
  input.click("left");
  input.click("right");
  input.click("middle");
  assert.deepEqual(calls, [
    [M(0x0002), M(0x0004)],
    [M(0x0008), M(0x0010)],
    [M(0x0020), M(0x0040)],
  ]);
});

test("mouseDown / mouseUp are single events", () => {
  const { calls, input } = mock();
  input.mouseDown("left");
  input.mouseUp("left");
  input.mouseDown("right");
  input.mouseUp("middle");
  assert.deepEqual(calls, [[M(0x0002)], [M(0x0004)], [M(0x0008)], [M(0x0040)]]);
});

test("scroll: down is a NEGATIVE wheel delta (two's complement DWORD), right is positive", () => {
  const { calls, input } = mock();
  input.scroll(120);          // scroll down one notch
  input.scroll(-120);         // scroll up one notch
  input.scroll(0, 240);       // scroll right
  input.scroll(0, -240);      // scroll left
  input.scroll(60, -30);      // both axes -> two events in one call
  assert.deepEqual(calls, [
    [M(0x0800, 0, 0, 0xffffff88)],
    [M(0x0800, 0, 0, 120)],
    [M(0x1000, 0, 0, 240)],
    [M(0x1000, 0, 0, 0xffffff10)],
    [M(0x0800, 0, 0, 0xffffffc4), M(0x1000, 0, 0, 0xffffffe2)],
  ]);
});

test("keyTap presses modifiers first and releases them last, in one call", () => {
  const { calls, input } = mock();
  input.keyTap(VK.LEFT, ["alt"]);
  assert.deepEqual(calls, [[
    K(VK.MENU, 0),
    K(VK.LEFT, 0x0001),          // extended key, down
    K(VK.LEFT, 0x0001 | 0x0002), // extended key, up
    K(VK.MENU, 0x0002),
  ]]);
});

test("keyTap with multiple modifiers releases in reverse order", () => {
  const { calls, input } = mock();
  input.keyTap(0x41, ["ctrl", "shift"]);
  assert.deepEqual(calls[0], [
    K(VK.CONTROL, 0), K(VK.SHIFT, 0),
    K(0x41, 0), K(0x41, 0x0002),
    K(VK.SHIFT, 0x0002), K(VK.CONTROL, 0x0002),
  ]);
});

test("extended flag only on navigation keys", () => {
  const { calls, input } = mock();
  input.keyTap(VK.RETURN);
  input.keyTap(VK.HOME);
  assert.deepEqual(calls[0], [K(VK.RETURN, 0), K(VK.RETURN, 0x0002)]);
  assert.deepEqual(calls[1], [K(VK.HOME, 0x0001), K(VK.HOME, 0x0003)]);
});

test("typeText uses KEYEVENTF_UNICODE, one down/up pair per UTF-16 unit", () => {
  const { calls, input } = mock();
  input.typeText("aé");
  assert.deepEqual(calls, [[
    K(0, 0x0004, 0x61), K(0, 0x0004 | 0x0002, 0x61),
    K(0, 0x0004, 0xe9), K(0, 0x0004 | 0x0002, 0xe9),
  ]]);
});

test("typeText sends astral characters as their two surrogates", () => {
  const { calls, input } = mock();
  input.typeText("😀"); // U+1F600 = D83D DE00
  assert.deepEqual(calls[0].map((i) => (i.kind === "key" ? [i.scan, i.flags] : null)), [
    [0xd83d, 0x4], [0xd83d, 0x6], [0xde00, 0x4], [0xde00, 0x6],
  ]);
});

test("mediaKey sends the right virtual-key codes", () => {
  const { calls, input } = mock();
  const expected: Record<string, number> = {
    vol_up: 0xaf, vol_down: 0xae, mute: 0xad, play_pause: 0xb3, next: 0xb0, prev: 0xb1,
  };
  for (const [name, vk] of Object.entries(expected)) {
    input.mediaKey(name as never);
    assert.deepEqual(calls.at(-1), [K(vk, 0), K(vk, 0x0002)], name);
  }
});

test("every whitelisted key name maps to a table entry and a valid sequence", () => {
  const { calls, input } = mock();
  for (const name of KEY_NAMES) {
    assert.ok(KEY_TABLE[name], name);
    input.namedKey(name);
  }
  assert.equal(calls.length, KEY_NAMES.length);
  // Ctrl+W: Ctrl down, W down, W up, Ctrl up
  const idx = KEY_NAMES.indexOf("Ctrl+W");
  assert.deepEqual(calls[idx], [K(VK.CONTROL, 0), K(0x57, 0), K(0x57, 2), K(VK.CONTROL, 2)]);
});

test("unknown media / key names are ignored rather than sent", () => {
  const { calls, input } = mock();
  input.mediaKey("eject" as never);
  input.namedKey("Win+R" as never);
  assert.equal(calls.length, 0);
});

test("a short SendInput return (e.g. UIPI) is reported but does not throw", () => {
  const { input } = mock(() => 0);
  const warn = console.warn;
  const seen: string[] = [];
  console.warn = (m: string) => { seen.push(m); };
  try {
    assert.doesNotThrow(() => input.click("left"));
  } finally {
    console.warn = warn;
  }
  assert.match(seen[0], /accepted 0\/2/);
});

test("dispatchInput maps validated commands onto the right calls", () => {
  const { calls, input } = mock();
  const run = (m: unknown) => {
    const cmd = parseCommand(m);
    assert.ok(cmd && cmd.type !== "nav", JSON.stringify(m));
    dispatchInput(cmd, input);
  };
  run({ type: "mouse_move", dx: 7, dy: 9 });
  run({ type: "mouse_click", button: "left" });
  run({ type: "scroll", dx: 0, dy: 120 });
  run({ type: "key", key: "Escape" });
  run({ type: "text", value: "x" });
  run({ type: "media", action: "mute" });
  assert.equal(calls.length, 6);
  assert.deepEqual(calls[0], [M(1, 7, 9)]);
  assert.deepEqual(calls[2], [M(0x0800, 0, 0, 0xffffff88)]);
  assert.deepEqual(calls[3], [K(VK.ESCAPE, 0), K(VK.ESCAPE, 2)]);
  assert.deepEqual(calls[5], [K(0xad, 0), K(0xad, 2)]);
});
