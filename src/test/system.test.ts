import { test } from "node:test";
import * as assert from "node:assert/strict";
import { ForegroundApi, SW_RESTORE, SW_SHOW, createForeground } from "../foreground";
import { CLOSE_REFUSAL_TEXT, checkCloseTarget } from "../appControl";
import { PowerApi, createPowerGuard } from "../power";
import { handleToNumber } from "../win32";

// ---------------------------------------------------------------------------
// Foreground forcing, with a fake Win32. Nothing here touches a real window.
// ---------------------------------------------------------------------------

const LAUNCHER = 100;
const BROWSER = 200;

/** A fake desktop where each rung of the ladder can be made to "work" or not. */
function fakeWin(works: { direct?: boolean; attach?: boolean; switch?: boolean; altTap?: boolean }, opts: { iconic?: boolean; throwIn?: string } = {}) {
  const calls: string[] = [];
  let fg = BROWSER;
  let attached = false;
  let altTapped = false;
  let iconic = opts.iconic ?? false;
  const maybeThrow = (name: string) => { if (opts.throwIn === name) throw new Error(`${name} exploded`); };

  const api: ForegroundApi = {
    getForegroundWindow: () => fg,
    getWindowThreadId: (h) => (h === BROWSER ? 7 : 5),
    getCurrentThreadId: () => 5,
    attachThreadInput: (a, b, on) => { calls.push(`attach(${a},${b},${on})`); maybeThrow("attach"); attached = on; return true; },
    setForegroundWindow: (h) => {
      calls.push(`setForeground(${h})`);
      maybeThrow("setForeground");
      // Which rung "unlocks" it depends on the scenario.
      const ok = (works.direct && !attached && !altTapped) || (works.attach && attached) || (works.altTap && altTapped);
      if (ok) fg = h;
      return !!ok;
    },
    bringWindowToTop: (h) => { calls.push(`bringToTop(${h})`); return true; },
    showWindow: (h, cmd) => { calls.push(`show(${h},${cmd})`); if (cmd === SW_RESTORE) iconic = false; return true; },
    switchToThisWindow: (h) => { calls.push(`switchTo(${h})`); if (works.switch) fg = h; },
    isIconic: () => iconic,
  };
  return {
    calls, api,
    altTap: () => { calls.push("altTap"); altTapped = true; },
    attachedNow: () => attached,
    foreground: () => fg,
  };
}

const run = (w: ReturnType<typeof fakeWin>) =>
  createForeground({ api: w.api, altTap: w.altTap, sleep: async () => {} }).force(LAUNCHER);

test("foreground: already in front -> no calls at all", async () => {
  const w = fakeWin({});
  const origGet = w.api.getForegroundWindow;
  w.api.getForegroundWindow = () => LAUNCHER;
  assert.notEqual(origGet(), LAUNCHER);
  const r = await run(w);
  assert.deepEqual(r, { ok: true, method: "already", tried: [] });
  assert.deepEqual(w.calls, []);
});

test("foreground: plain SetForegroundWindow works -> stops at rung 1", async () => {
  const w = fakeWin({ direct: true });
  const r = await run(w);
  assert.equal(r.ok, true);
  assert.equal(r.method, "direct");
  assert.deepEqual(r.tried, ["direct"]);
  assert.ok(!w.calls.some((c) => c.startsWith("attach")), "never attached threads");
  assert.ok(!w.calls.includes("altTap"), "never injected a key");
});

test("foreground: blocked by the foreground lock -> AttachThreadInput trick, and it detaches afterwards", async () => {
  const w = fakeWin({ attach: true });
  const r = await run(w);
  assert.equal(r.ok, true);
  assert.equal(r.method, "attach");
  assert.deepEqual(r.tried, ["direct", "attach"]);
  // attached to the browser's thread (7) from ours (5), did the work, then detached
  const attachCalls = w.calls.filter((c) => c.startsWith("attach"));
  assert.deepEqual(attachCalls, ["attach(5,7,true)", "attach(5,7,false)"]);
  assert.ok(w.calls.indexOf("attach(5,7,true)") < w.calls.indexOf("bringToTop(100)"));
  assert.ok(w.calls.indexOf("bringToTop(100)") < w.calls.lastIndexOf("setForeground(100)"));
  assert.equal(w.attachedNow(), false, "thread input is detached again");
});

test("foreground: SwitchToThisWindow rung", async () => {
  const w = fakeWin({ switch: true });
  const r = await run(w);
  assert.equal(r.method, "switch");
  assert.deepEqual(r.tried, ["direct", "attach", "switch"]);
});

test("foreground: synthetic Alt tap is the last resort and is followed by SetForegroundWindow", async () => {
  const w = fakeWin({ altTap: true });
  const r = await run(w);
  assert.equal(r.ok, true);
  assert.equal(r.method, "alt-tap");
  assert.deepEqual(r.tried, ["direct", "attach", "switch", "alt-tap"]);
  assert.ok(w.calls.indexOf("altTap") < w.calls.lastIndexOf("setForeground(100)"), "Alt tap comes BEFORE the final SetForegroundWindow");
});

test("foreground: every rung fails -> ok:false so the caller can fall back (no exception)", async () => {
  const w = fakeWin({});
  const r = await run(w);
  assert.deepEqual(r, { ok: false, method: "failed", tried: ["direct", "attach", "switch", "alt-tap"] });
});

test("foreground: the Alt tap is not used when an earlier rung already worked", async () => {
  for (const works of [{ direct: true }, { attach: true }, { switch: true }]) {
    const w = fakeWin(works);
    await run(w);
    assert.ok(!w.calls.includes("altTap"), JSON.stringify(works));
  }
});

test("foreground: a minimized launcher is restored first", async () => {
  const w = fakeWin({ direct: true }, { iconic: true });
  await run(w);
  assert.equal(w.calls[0], `show(${LAUNCHER},${SW_RESTORE})`);
});

test("foreground: a native call that throws is survived, later rungs still run, threads are detached", async () => {
  const w = fakeWin({ altTap: true }, { throwIn: "setForeground" });
  const logs: string[] = [];
  const r = await createForeground({ api: w.api, altTap: w.altTap, sleep: async () => {}, log: (m) => logs.push(m) }).force(LAUNCHER);
  assert.equal(r.ok, false);
  assert.deepEqual(r.tried, ["direct", "attach", "switch", "alt-tap"]);
  assert.ok(logs.length >= 2, "each throw is logged");
  assert.equal(w.attachedNow(), false, "attach is undone even though setForeground threw inside it");
});

test("foreground: AttachThreadInput is skipped when the foreground thread is our own", async () => {
  const w = fakeWin({ direct: false });
  w.api.getWindowThreadId = () => 5; // same thread as getCurrentThreadId()
  await run(w);
  assert.ok(!w.calls.some((c) => c.startsWith("attach")));
});

test("foreground: a foreground change that lands a few ms late still counts", async () => {
  const w = fakeWin({});
  let polls = 0;
  const base = w.api.setForegroundWindow;
  w.api.setForegroundWindow = (h) => { base(h); return true; };
  w.api.getForegroundWindow = () => (polls++ > 1 ? LAUNCHER : BROWSER);
  const r = await run(w);
  assert.equal(r.ok, true);
  assert.equal(r.method, "direct");
});

test("foreground: showWindow(SW_SHOW) is used in the attach rung", async () => {
  const w = fakeWin({ attach: true });
  await run(w);
  assert.ok(w.calls.includes(`show(${LAUNCHER},${SW_SHOW})`));
});

// ---------------------------------------------------------------------------
// Close-app safety
// ---------------------------------------------------------------------------

const OWN_PID = 4242;
const closeApi = (fg: number, pid: number, cls: string) => ({
  getForegroundWindow: () => fg,
  getWindowPid: () => pid,
  getClassName: () => cls,
});

test("close app: a normal application window is allowed", () => {
  assert.deepEqual(checkCloseTarget(closeApi(300, 999, "Chrome_WidgetWin_1"), OWN_PID), { ok: true });
  assert.deepEqual(checkCloseTarget(closeApi(300, 999, "Notepad"), OWN_PID), { ok: true });
});

test("close app: the launcher itself is refused (any window owned by our process)", () => {
  assert.deepEqual(checkCloseTarget(closeApi(100, OWN_PID, "Chrome_WidgetWin_1"), OWN_PID), { ok: false, reason: "launcher" });
});

test("close app: no foreground window is refused", () => {
  assert.deepEqual(checkCloseTarget(closeApi(0, 0, ""), OWN_PID), { ok: false, reason: "no-window" });
});

test("close app: desktop and taskbar are refused (Alt+F4 there opens the shutdown dialog)", () => {
  for (const cls of ["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"]) {
    assert.deepEqual(checkCloseTarget(closeApi(5, 999, cls), OWN_PID), { ok: false, reason: "shell" }, cls);
  }
});

test("close app: the launcher check runs before the class check and every refusal has user text", () => {
  assert.deepEqual(checkCloseTarget(closeApi(5, OWN_PID, "Progman"), OWN_PID), { ok: false, reason: "launcher" });
  for (const r of ["no-window", "launcher", "shell"] as const) assert.ok(CLOSE_REFUSAL_TEXT[r].length > 10);
});

// ---------------------------------------------------------------------------
// Power guard
// ---------------------------------------------------------------------------

function fakePower() {
  const events: string[] = [];
  const live = new Set<number>();
  let next = 10;
  const api: PowerApi = {
    start: (t) => { events.push(`start:${t}`); live.add(next); return next++; },
    stop: (id) => { events.push(`stop:${id}`); live.delete(id); },
    isStarted: (id) => live.has(id),
  };
  return { api, events, live };
}

test("power guard: prevents DISPLAY sleep, starts once, stops once", () => {
  const p = fakePower();
  const g = createPowerGuard(p.api);
  assert.equal(g.active(), false);
  g.start();
  g.start(); // idempotent
  assert.deepEqual(p.events, ["start:prevent-display-sleep"]);
  assert.equal(g.active(), true);
  g.stop();
  g.stop();
  assert.deepEqual(p.events, ["start:prevent-display-sleep", "stop:10"]);
  assert.equal(g.active(), false);
});

test("power guard: restarts if the OS dropped the blocker, and stop() after that is safe", () => {
  const p = fakePower();
  const g = createPowerGuard(p.api);
  g.start();
  p.live.clear(); // blocker vanished
  g.start();
  assert.deepEqual(p.events, ["start:prevent-display-sleep", "start:prevent-display-sleep"]);
  p.live.clear();
  assert.doesNotThrow(() => g.stop());
});

// ---------------------------------------------------------------------------
test("handleToNumber reads 64- and 32-bit native window handles", () => {
  const b64 = Buffer.alloc(8); b64.writeBigUInt64LE(0x1234abcdn);
  assert.equal(handleToNumber(b64), 0x1234abcd);
  const b32 = Buffer.alloc(4); b32.writeUInt32LE(0x55aa);
  assert.equal(handleToNumber(b32), 0x55aa);
});
