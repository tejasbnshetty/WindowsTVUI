import { test } from "node:test";
import * as assert from "node:assert/strict";
import { DisplayInfo, WindowLike, createDisplayManager, displayContaining, resolveDisplay } from "../displays";
import type { SavedDisplay } from "../settings";

const laptop: DisplayInfo = { id: 1, label: "Built-in", x: 0, y: 0, width: 1920, height: 1080, primary: true };
const tv: DisplayInfo = { id: 2, label: "LG TV", x: 1920, y: 0, width: 3840, height: 2160, primary: false };
const mon: DisplayInfo = { id: 3, label: "DELL U2720Q", x: -2560, y: 0, width: 2560, height: 1440, primary: false };

test("default: the display the launcher started on, else primary", () => {
  assert.equal(resolveDisplay([laptop, tv], { startedOnId: 2 })?.display.id, 2);
  assert.equal(resolveDisplay([laptop, tv], { startedOnId: 2 })?.source, "started");
  assert.equal(resolveDisplay([laptop, tv], {})?.display.id, 1);
  assert.equal(resolveDisplay([laptop, tv], { startedOnId: 99 })?.source, "primary");
});

test("config.json display: primary / id / name fragment / auto / unknown", () => {
  assert.equal(resolveDisplay([laptop, tv], { config: "primary", startedOnId: 2 })?.display.id, 1);
  assert.equal(resolveDisplay([laptop, tv], { config: 2 })?.display.id, 2);
  assert.equal(resolveDisplay([laptop, tv, mon], { config: "dell" })?.display.id, 3);
  assert.equal(resolveDisplay([laptop, tv], { config: "auto", startedOnId: 2 })?.source, "started");
  assert.equal(resolveDisplay([laptop, tv], { config: 77, startedOnId: 2 })?.source, "started", "unknown id falls through");
  assert.equal(resolveDisplay([laptop, tv], { config: "nonexistent" })?.source, "primary");
});

test("a choice made from the remote beats config.json", () => {
  const saved: SavedDisplay = { id: 2, label: "LG TV", width: 3840, height: 2160 };
  const r = resolveDisplay([laptop, tv], { saved, config: "primary", startedOnId: 1 });
  assert.equal(r?.display.id, 2);
  assert.equal(r?.source, "saved");
});

test("an unplugged saved display is skipped (fallback), and used again when it returns", () => {
  const saved: SavedDisplay = { id: 2, label: "LG TV", width: 3840, height: 2160 };
  assert.equal(resolveDisplay([laptop], { saved, startedOnId: 1 })?.display.id, 1, "TV unplugged -> laptop");
  assert.equal(resolveDisplay([laptop, tv], { saved, startedOnId: 1 })?.display.id, 2, "TV re-plugged -> TV");
});

test("a re-plugged monitor with a NEW id is matched by label and resolution", () => {
  const saved: SavedDisplay = { id: 2, label: "LG TV", width: 3840, height: 2160 };
  const replugged = { ...tv, id: 55 };
  assert.equal(resolveDisplay([laptop, replugged], { saved })?.display.id, 55);
  const differentSize = { ...tv, id: 56, width: 1920, height: 1080 };
  assert.equal(resolveDisplay([laptop, differentSize], { saved })?.display.id, 1);
});

test("no displays -> null", () => {
  assert.equal(resolveDisplay([], {}), null);
});

test("displayContaining uses the window centre, else the largest overlap", () => {
  assert.equal(displayContaining([laptop, tv], { x: 1920, y: 0, width: 3840, height: 2160 })?.id, 2);
  assert.equal(displayContaining([laptop, tv], { x: 100, y: 100, width: 400, height: 300 })?.id, 1);
  assert.equal(displayContaining([laptop, tv], { x: 1800, y: 0, width: 400, height: 300 })?.id, 2, "centre is on the TV");
  assert.equal(displayContaining([laptop], { x: 5000, y: 5000, width: 10, height: 10 }), undefined);
});

// ---------------- manager with fakes ----------------

function setup(initial: { displays: DisplayInfo[]; startOn?: DisplayInfo; fullscreen?: boolean; saved?: SavedDisplay; config?: undefined | "primary" | number | string }) {
  let displays = initial.displays;
  let saved: SavedDisplay | null = initial.saved ?? null;
  const subs: Array<() => void> = [];
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const calls: string[] = [];
  let leaveCb: (() => void) | null = null;
  let bounds = initial.startOn ? { x: initial.startOn.x, y: initial.startOn.y, width: initial.startOn.width, height: initial.startOn.height } : { x: 0, y: 0, width: 1920, height: 1080 };
  let fs = initial.fullscreen ?? true;

  const win: WindowLike = {
    isDestroyed: () => false,
    getBounds: () => bounds,
    setBounds: (r) => { calls.push(`setBounds(${r.x},${r.y},${r.width}x${r.height})`); bounds = { ...r }; },
    isFullScreen: () => fs,
    setFullScreen: (on) => { calls.push(`fullscreen(${on})`); fs = on; },
    once: (_e, cb) => { leaveCb = cb; },
  };
  let changes = 0;
  const manager = createDisplayManager({
    listDisplays: () => displays,
    subscribe: (cb) => { subs.push(cb); return () => { subs.splice(subs.indexOf(cb), 1); }; },
    getWindow: () => win,
    getSaved: () => saved,
    setSaved: (d) => { saved = d; },
    config: initial.config,
    startedOnId: initial.startOn?.id ?? null,
    onChange: () => { changes++; },
    schedule: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return { cancel: () => { t.cancelled = true; } }; },
  });
  return {
    manager, calls, subs,
    setDisplays: (d: DisplayInfo[]) => { displays = d; },
    getSaved: () => saved,
    changes: () => changes,
    leaveFullscreen: () => { fs = false; const cb = leaveCb; leaveCb = null; cb?.(); },
    runTimers: () => { for (const t of timers.splice(0)) if (!t.cancelled) t.fn(); },
    win: () => ({ bounds, fullscreen: fs }),
  };
}

test("choose(): leaves fullscreen, moves to the chosen display, re-enters fullscreen, saves the choice", () => {
  const t = setup({ displays: [laptop, tv], startOn: laptop });
  assert.equal(t.manager.choose(2), true);
  assert.deepEqual(t.calls, ["fullscreen(false)"], "must leave fullscreen first (fullscreen ignores setBounds)");
  t.leaveFullscreen();
  assert.deepEqual(t.calls, ["fullscreen(false)", "setBounds(1920,0,3840x2160)", "fullscreen(true)"]);
  assert.deepEqual(t.getSaved(), { id: 2, label: "LG TV", width: 3840, height: 2160 });
  assert.equal(t.manager.views().find((v) => v.current)?.id, 2);
});

test("choose() with an id that is not connected is rejected and changes nothing", () => {
  const t = setup({ displays: [laptop], startOn: laptop });
  assert.equal(t.manager.choose(2), false);
  assert.equal(t.getSaved(), null);
  assert.deepEqual(t.calls, []);
});

test("choose(null) resets to the default display", () => {
  const t = setup({ displays: [laptop, tv], startOn: laptop });
  t.manager.choose(2);
  t.leaveFullscreen();
  t.calls.length = 0;
  assert.equal(t.manager.choose(null), true);
  assert.equal(t.getSaved(), null);
  t.leaveFullscreen();
  assert.deepEqual(t.calls, ["fullscreen(false)", "setBounds(0,0,1920x1080)", "fullscreen(true)"]);
});

test("if leave-full-screen never fires, a timeout still completes the move", () => {
  const t = setup({ displays: [laptop, tv], startOn: laptop });
  t.manager.choose(2);
  t.runTimers(); // the 800 ms fallback
  assert.deepEqual(t.calls, ["fullscreen(false)", "setBounds(1920,0,3840x2160)", "fullscreen(true)"]);
});

test("the move is not applied twice when both the event and the timeout fire", () => {
  const t = setup({ displays: [laptop, tv], startOn: laptop });
  t.manager.choose(2);
  t.leaveFullscreen();
  t.runTimers();
  assert.equal(t.calls.filter((c) => c.startsWith("setBounds")).length, 1);
});

test("apply() does nothing when the window is already where it should be", () => {
  const t = setup({ displays: [laptop, tv], startOn: laptop });
  t.manager.apply();
  assert.deepEqual(t.calls, []);
});

test("HOT-UNPLUG: the launcher's display disappears -> falls back to the remaining display", () => {
  const t = setup({ displays: [laptop, tv], startOn: tv });
  t.manager.choose(2); // user pinned the TV; it is already there, so nothing moves
  assert.deepEqual(t.calls, []);
  t.setDisplays([laptop]); // HDMI pulled
  t.subs.forEach((cb) => cb());
  t.runTimers(); // debounce
  t.leaveFullscreen();
  assert.deepEqual(t.calls, ["fullscreen(false)", "setBounds(0,0,1920x1080)", "fullscreen(true)"]);
  assert.deepEqual(t.getSaved()?.id, 2, "the choice is remembered even while unplugged");
});

test("HOT-PLUG: the saved display comes back -> the launcher moves back to it", () => {
  const saved: SavedDisplay = { id: 2, label: "LG TV", width: 3840, height: 2160 };
  const t = setup({ displays: [laptop], startOn: laptop, saved }); // TV was chosen earlier but is unplugged right now
  t.manager.apply();
  assert.deepEqual(t.calls, [], "already on the fallback display, nothing to do");
  t.setDisplays([laptop, tv]); // HDMI plugged in
  t.subs.forEach((cb) => cb());
  t.runTimers(); // debounce fires -> apply()
  t.leaveFullscreen();
  assert.deepEqual(t.calls, ["fullscreen(false)", "setBounds(1920,0,3840x2160)", "fullscreen(true)"]);
});

test("hot-plug events are debounced into one apply", () => {
  const t = setup({ displays: [laptop, tv], startOn: laptop });
  for (let i = 0; i < 5; i++) t.subs.forEach((cb) => cb());
  const before = t.changes();
  t.runTimers(); // only the last debounce timer is live
  assert.equal(t.changes() - before, 2, "one apply() + one onChange notification, not five");
});

test("a resolution change on the same display re-fits the window", () => {
  const t = setup({ displays: [laptop], startOn: laptop });
  t.setDisplays([{ ...laptop, width: 1280, height: 720 }]);
  t.manager.apply();
  t.leaveFullscreen();
  assert.deepEqual(t.calls, ["fullscreen(false)", "setBounds(0,0,1280x720)", "fullscreen(true)"]);
});

test("views(): labels fall back to 'Display N', primary and current flags", () => {
  const t = setup({ displays: [{ ...laptop, label: "" }, tv], startOn: laptop });
  const v = t.manager.views();
  assert.equal(v[0].label, "Display 1");
  assert.equal(v[0].primary, true);
  assert.equal(v[0].current, true);
  assert.equal(v[1].current, false);
});

test("dispose() unsubscribes from display events", () => {
  const t = setup({ displays: [laptop], startOn: laptop });
  assert.equal(t.subs.length, 1);
  t.manager.dispose();
  assert.equal(t.subs.length, 0);
});
