import { test } from "node:test";
import * as assert from "node:assert/strict";
import { InputBackend, KEY_TABLE, RawInput, VK, createInput } from "../input";
import { KEY_NAMES, parseCommand } from "../protocol";
import { dispatchInput } from "../dispatch";

// A fake scan-code table so tests can see that scan codes are attached.
const scan = (vk: number) => (vk ^ 0x55) & 0xff;

type LogEntry = RawInput[] | { wait: number };

/** Mock backend + instant fake clock. Nothing here touches the OS or sends real input. */
function mock(opts: { accept?: (n: number) => number; withScan?: boolean; throwOnce?: boolean } = {}) {
  const log: LogEntry[] = [];
  let threw = false;
  const backend: InputBackend = {
    sendInput(inputs) {
      if (opts.throwOnce && !threw) { threw = true; throw new Error("boom"); }
      log.push(inputs);
      return opts.accept ? opts.accept(inputs.length) : inputs.length;
    },
    ...(opts.withScan === false ? {} : { scanCode: scan }),
  };
  const input = createInput(backend, { wait: async (ms) => { log.push({ wait: ms }); } });
  return { log, input };
}

const M = (flags: number, dx = 0, dy = 0, mouseData = 0): RawInput => ({ kind: "mouse", dx, dy, mouseData, flags });
const K = (vk: number, flags: number): RawInput => ({ kind: "key", vk, scan: scan(vk), flags });
const U = (unit: number, up: boolean): RawInput => ({ kind: "key", vk: 0, scan: unit, flags: 0x4 | (up ? 0x2 : 0) });
const HOLD = { wait: 15 };
const GAP = { wait: 8 };

// ---------------- mouse (immediate, synchronous) ----------------

test("moveRelative sends one relative MOVE event, immediately", () => {
  const { log, input } = mock();
  input.moveRelative(5, -3);
  assert.deepEqual(log, [[M(0x0001, 5, -3)]]); // no await: mouse is not queued
});

test("moveRelative(0,0) sends nothing", () => {
  const { log, input } = mock();
  input.moveRelative(0, 0);
  assert.equal(log.length, 0);
});

test("click = down+up in a single atomic call, per button", () => {
  const { log, input } = mock();
  input.click("left");
  input.click("right");
  input.click("middle");
  assert.deepEqual(log, [
    [M(0x0002), M(0x0004)],
    [M(0x0008), M(0x0010)],
    [M(0x0020), M(0x0040)],
  ]);
});

test("mouseDown / mouseUp are single events", () => {
  const { log, input } = mock();
  input.mouseDown("left");
  input.mouseUp("left");
  input.mouseDown("right");
  input.mouseUp("middle");
  assert.deepEqual(log, [[M(0x0002)], [M(0x0004)], [M(0x0008)], [M(0x0040)]]);
});

test("scroll: down is a NEGATIVE wheel delta (two's complement DWORD), right is positive", () => {
  const { log, input } = mock();
  input.scroll(120);
  input.scroll(-120);
  input.scroll(0, 240);
  input.scroll(0, -240);
  input.scroll(60, -30);
  assert.deepEqual(log, [
    [M(0x0800, 0, 0, 0xffffff88)],
    [M(0x0800, 0, 0, 120)],
    [M(0x1000, 0, 0, 240)],
    [M(0x1000, 0, 0, 0xffffff10)],
    [M(0x0800, 0, 0, 0xffffffc4), M(0x1000, 0, 0, 0xffffffe2)],
  ]);
});

// ---------------- keyboard: scan codes, dwell, ordering ----------------

test("a key press is TWO SendInput calls with a dwell between them, and carries vk AND scan code", async () => {
  const { log, input } = mock();
  input.keyTap(VK.BACK);
  await input.idle();
  assert.deepEqual(log, [[K(VK.BACK, 0)], HOLD, [K(VK.BACK, 0x2)], GAP]);
  const down = (log[0] as RawInput[])[0];
  assert.ok(down.kind === "key" && down.vk === 0x08 && down.scan !== 0, "Backspace has both vk and a non-zero scan code");
});

test("keyTap is asynchronous: nothing is sent until the queue runs", async () => {
  const { log, input } = mock();
  input.keyTap(VK.BACK);
  assert.equal(log.length, 0, "key events are queued, not sent inline");
  await input.idle();
  assert.ok(log.length > 0);
});

test("modifiers go down first, stay down during the dwell, and come up last", async () => {
  const { log, input } = mock();
  input.keyTap(VK.LEFT, ["alt"]);
  await input.idle();
  assert.deepEqual(log, [
    [K(VK.MENU, 0), K(VK.LEFT, 0x0001)],            // Alt down, Left down (extended)
    HOLD,
    [K(VK.LEFT, 0x0001 | 0x0002), K(VK.MENU, 0x0002)], // Left up, Alt up
    GAP,
  ]);
});

test("multiple modifiers release in reverse order", async () => {
  const { log, input } = mock();
  input.keyTap(0x41, ["ctrl", "shift"]);
  await input.idle();
  assert.deepEqual(log[2], [K(0x41, 2), K(VK.SHIFT, 2), K(VK.CONTROL, 2)]);
});

test("consecutive Backspaces never interleave: down,hold,up,gap per press", async () => {
  const { log, input } = mock();
  input.namedKey("Backspace");
  input.namedKey("Backspace");
  input.namedKey("Backspace");
  await input.idle();
  const one = [[K(VK.BACK, 0)], HOLD, [K(VK.BACK, 2)], GAP];
  assert.deepEqual(log, [...one, ...one, ...one]);
});

test("text typed right before a Backspace is fully delivered first (strict ordering)", async () => {
  const { log, input } = mock();
  input.typeText("é😀");
  input.namedKey("Backspace");
  await input.idle();
  assert.deepEqual(log[0], [U(0xe9, false), U(0xe9, true), U(0xd83d, false), U(0xd83d, true), U(0xde00, false), U(0xde00, true)]);
  assert.deepEqual(log[1], GAP);
  assert.deepEqual(log.slice(2), [[K(VK.BACK, 0)], HOLD, [K(VK.BACK, 2)], GAP]);
});

test("typeText uses KEYEVENTF_UNICODE with the code unit as scan code and no vk", async () => {
  const { log, input } = mock();
  input.typeText("a");
  await input.idle();
  assert.deepEqual(log[0], [U(0x61, false), U(0x61, true)]);
});

test("extended flag only on navigation keys", async () => {
  const { log, input } = mock();
  input.keyTap(VK.RETURN);
  input.keyTap(VK.HOME);
  await input.idle();
  assert.deepEqual(log[0], [K(VK.RETURN, 0)]);
  assert.deepEqual(log[4], [K(VK.HOME, 0x0001)]);
  assert.deepEqual(log[6], [K(VK.HOME, 0x0003)]);
});

test("without a scanCode backend the scan code is simply 0 (still sends)", async () => {
  const { log, input } = mock({ withScan: false });
  input.keyTap(VK.BACK);
  await input.idle();
  assert.deepEqual(log[0], [{ kind: "key", vk: 8, scan: 0, flags: 0 }]);
});

test("mediaKey is a held tap with the right virtual-key code", async () => {
  const { log, input } = mock();
  const expected: Record<string, number> = { vol_up: 0xaf, vol_down: 0xae, mute: 0xad, play_pause: 0xb3, next: 0xb0, prev: 0xb1 };
  for (const [name, vk] of Object.entries(expected)) {
    log.length = 0;
    input.mediaKey(name as never);
    await input.idle();
    assert.deepEqual(log, [[K(vk, 0)], HOLD, [K(vk, 2)], GAP], name);
  }
});

test("every whitelisted key name maps to a table entry and produces a balanced down/up sequence", async () => {
  for (const name of KEY_NAMES) {
    const { log, input } = mock();
    assert.ok(KEY_TABLE[name], name);
    input.namedKey(name);
    await input.idle();
    const downs = (log[0] as RawInput[]);
    const ups = (log[2] as RawInput[]);
    assert.equal(downs.length, ups.length, name);
    assert.ok(downs.every((e) => e.kind === "key" && (e.flags & 2) === 0), `${name} downs`);
    assert.ok(ups.every((e) => e.kind === "key" && (e.flags & 2) === 2), `${name} ups`);
  }
  const { log, input } = mock();
  input.namedKey("Ctrl+W");
  await input.idle();
  assert.deepEqual(log[0], [K(VK.CONTROL, 0), K(0x57, 0)]);
  assert.deepEqual(log[2], [K(0x57, 2), K(VK.CONTROL, 2)]);
});

test("Alt+F4 and Alt+Tab are NOT reachable as remote key names (only via the guarded app command)", () => {
  assert.equal(parseCommand({ type: "key", key: "Alt+F4" }), null);
  assert.equal(parseCommand({ type: "key", key: "Alt+Tab" }), null);
});

test("unknown media / key names are ignored rather than sent", async () => {
  const { log, input } = mock();
  input.mediaKey("eject" as never);
  input.namedKey("Win+R" as never);
  await input.idle();
  assert.equal(log.length, 0);
});

// ---------------- failure handling ----------------

test("a short SendInput return (e.g. UIPI) is reported but does not throw", () => {
  const { input } = mock({ accept: () => 0 });
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

test("a SendInput exception does not break the keyboard queue", async () => {
  const { log, input } = mock({ throwOnce: true });
  const err = console.error;
  console.error = () => {};
  try {
    input.namedKey("Backspace"); // its key-down call throws once
    input.namedKey("Enter");
    await input.idle();
  } finally {
    console.error = err;
  }
  assert.ok(log.some((e) => Array.isArray(e) && e.some((i) => i.kind === "key" && i.vk === VK.RETURN)), "Enter was still sent");
});

// ---------------- dispatch ----------------

test("dispatchInput maps validated commands onto the right calls", async () => {
  const { log, input } = mock();
  const run = (m: unknown) => {
    const cmd = parseCommand(m);
    assert.ok(cmd, JSON.stringify(m));
    dispatchInput(cmd as never, input);
  };
  run({ type: "mouse_move", dx: 7, dy: 9 });
  run({ type: "mouse_click", button: "left" });
  run({ type: "scroll", dx: 0, dy: 120 });
  run({ type: "key", key: "Escape" });
  run({ type: "text", value: "x" });
  run({ type: "media", action: "mute" });
  await input.idle();
  assert.deepEqual(log[0], [M(1, 7, 9)]);
  assert.deepEqual(log[1], [M(0x0002), M(0x0004)]);
  assert.deepEqual(log[2], [M(0x0800, 0, 0, 0xffffff88)]);
  const flat = log.filter(Array.isArray) as RawInput[][];
  assert.ok(flat.some((c) => c.length === 1 && c[0].kind === "key" && c[0].vk === VK.ESCAPE));
  assert.ok(flat.some((c) => c.length === 2 && c[0].kind === "key" && c[0].vk === 0 && (c[0] as { scan: number }).scan === 0x78));
  assert.ok(flat.some((c) => c.length === 1 && c[0].kind === "key" && c[0].vk === 0xad));
});
