import { test } from "node:test";
import * as assert from "node:assert/strict";
import { HERO, clampFocus, firstFocus, moveFocus, sameFocus, type Focus } from "../ui/nav";
import { contentWidth, followScroll, pageScroll, rowScroll } from "../ui/scroll";
import { createIdleTimer, type IdleDeps } from "../ui/idle";
import { derivePairing, formatCountdown } from "../ui/screens";
import { buildSections, MENU, minutesLabel, nextChoice, type SettingsData } from "../ui/settingsModel";
import { clampSettingsFocus, stepSettings, type SettingsFocus } from "../ui/settingsNav";
import { ROW_GEOMETRY, TILE_W, GAP, ROW_PAD_START, PEEK, HERO_H, ROW_H, VIEWPORT_H, pageGeometry, viewportWidthRem } from "../ui/layout";
import { buildRows, groupByCategory, rowCounts } from "../ui/rows";
import { DEFAULT_UI, mergeUi, sanitizeUi } from "../uiSettings";
import { formatClock, msToNextMinute } from "../ui/clock";
import type { LauncherInfo, PublicApp } from "../ui/types";

// ===========================================================================
// Focus navigation
// ===========================================================================

const counts = [5, 3, 5, 2]; // Streaming, Music, Local, Apps(+settings)
const row = (r: number, c: number): Focus => ({ zone: "row", row: r, col: c });

test("nav: left/right move inside a row and STOP at the ends (no wrap)", () => {
  assert.deepEqual(moveFocus(counts, row(0, 2), "right").focus, row(0, 3));
  assert.deepEqual(moveFocus(counts, row(0, 2), "left").focus, row(0, 1));
  assert.deepEqual(moveFocus(counts, row(0, 0), "left").focus, row(0, 0));
  assert.deepEqual(moveFocus(counts, row(0, 4), "right").focus, row(0, 4));
  assert.deepEqual(moveFocus(counts, row(3, 1), "right").focus, row(3, 1));
});

test("nav: down/up move between rows and keep the preferred column when the target row is long enough", () => {
  let m = moveFocus(counts, row(0, 4), "down", 4);
  assert.deepEqual(m.focus, row(1, 2), "Music has 3 tiles: column clamps to 2");
  assert.equal(m.memory, 4, "...but the preferred column (4) is remembered");
  m = moveFocus(counts, m.focus, "down", m.memory);
  assert.deepEqual(m.focus, row(2, 4), "...and restored on the next long row");
  m = moveFocus(counts, m.focus, "up", m.memory);
  assert.deepEqual(m.focus, row(1, 2));
});

test("nav: left/right update the remembered column", () => {
  const m = moveFocus(counts, row(0, 1), "right", 0);
  assert.equal(m.memory, 2);
});

test("nav: UP from the first row goes to the hero, DOWN from the hero returns to the first row", () => {
  assert.deepEqual(moveFocus(counts, row(0, 3), "up", 3).focus, HERO);
  const back = moveFocus(counts, HERO, "down", 3);
  assert.deepEqual(back.focus, row(0, 3), "the column you left from");
});

test("nav: the hero ignores left/right/up; the last row ignores down", () => {
  for (const d of ["left", "right", "up"] as const) assert.deepEqual(moveFocus(counts, HERO, d).focus, HERO);
  assert.deepEqual(moveFocus(counts, row(3, 0), "down").focus, row(3, 0));
});

test("nav: empty rows are skipped in both directions", () => {
  const c = [4, 0, 3];
  assert.deepEqual(moveFocus(c, row(0, 0), "down").focus, row(2, 0));
  assert.deepEqual(moveFocus(c, row(2, 1), "up", 1).focus, row(0, 1));
  assert.deepEqual(moveFocus([0, 0, 2], HERO, "down").focus, row(2, 0));
  assert.deepEqual(moveFocus([0, 0], HERO, "down").focus, HERO, "nothing to go down to");
});

test("nav: firstFocus / clampFocus keep focus valid when rows change", () => {
  assert.deepEqual(firstFocus([3, 2]), row(0, 0));
  assert.deepEqual(firstFocus([0, 2]), row(1, 0));
  assert.deepEqual(firstFocus([]), HERO);
  assert.deepEqual(clampFocus([3, 2], row(1, 5)), row(1, 1), "column clamps");
  assert.deepEqual(clampFocus([3], row(4, 0)), row(0, 0), "row disappeared");
  assert.deepEqual(clampFocus([3, 0], row(1, 0)), row(0, 0), "row became empty");
  assert.deepEqual(clampFocus([], row(0, 0)), HERO);
  assert.deepEqual(clampFocus([3], HERO), HERO);
  assert.ok(sameFocus(row(1, 2), row(1, 2)) && !sameFocus(row(1, 2), row(1, 3)) && !sameFocus(HERO, row(0, 0)) && sameFocus(HERO, HERO));
});

test("rows: grouped in the fixed order, Settings is the LAST tile of the LAST row", () => {
  const app = (id: string, category: string) => ({ id, name: id, category, type: "url", color: "#000000", iconPath: null, imageUrl: null, installed: null }) as PublicApp;
  const rows = buildRows([app("a", "Apps"), app("b", "Music"), app("c", "Streaming"), app("d", "Zebra"), app("e", "Local & Media"), app("f", "Aardvark")]);
  assert.deepEqual(rows.map((r) => r.title), ["Streaming", "Music", "Local & Media", "Apps", "Aardvark", "Zebra"], "known categories first, others alphabetical");
  const last = rows[rows.length - 1].items;
  assert.equal(last[last.length - 1].kind, "settings");
  assert.equal(rows.flatMap((r) => r.items).filter((i) => i.kind === "settings").length, 1);
  assert.deepEqual(rowCounts(rows), [1, 1, 1, 1, 1, 2]);
  assert.deepEqual(buildRows([]).map((r) => [r.title, r.items.map((i) => i.kind)]), [["Apps", ["settings"]]], "no apps: still reachable Settings");
  assert.deepEqual(groupByCategory([{ category: "X" }, { category: "X" }]).map((g) => g.apps.length), [2]);
});

// ===========================================================================
// Scroll follows focus
// ===========================================================================

test("followScroll: no movement while the item (with peek) is already visible", () => {
  assert.equal(followScroll({ scroll: 0, itemStart: 10, itemSize: 20, viewport: 100, content: 500 }), 0);
  assert.equal(followScroll({ scroll: 50, itemStart: 60, itemSize: 20, viewport: 100, content: 500 }), 50);
});

test("followScroll: scrolls the MINIMUM needed, in either direction", () => {
  assert.equal(followScroll({ scroll: 0, itemStart: 120, itemSize: 20, viewport: 100, content: 500 }), 40, "item ends at 140, window ends at 100");
  assert.equal(followScroll({ scroll: 200, itemStart: 150, itemSize: 20, viewport: 100, content: 500 }), 150);
});

test("followScroll: peek keeps the neighbouring tile partly visible", () => {
  assert.equal(followScroll({ scroll: 0, itemStart: 70, itemSize: 20, viewport: 100, content: 500, peekAfter: 15 }), 5);
  assert.equal(followScroll({ scroll: 100, itemStart: 105, itemSize: 20, viewport: 100, content: 500, peekBefore: 15 }), 90);
});

test("followScroll: clamped to [0, content - viewport]", () => {
  assert.equal(followScroll({ scroll: 0, itemStart: 480, itemSize: 20, viewport: 100, content: 500, peekAfter: 50 }), 400, "cannot scroll past the end");
  assert.equal(followScroll({ scroll: 30, itemStart: 0, itemSize: 20, viewport: 100, content: 500, peekBefore: 50 }), 0, "cannot scroll before the start");
  assert.equal(followScroll({ scroll: 0, itemStart: 0, itemSize: 20, viewport: 100, content: 50 }), 0, "content smaller than the window never scrolls");
});

test("rowScroll (real 1080p geometry): first tiles don't scroll, later ones scroll just enough, the last tile reaches the end", () => {
  const vw = viewportWidthRem(1920, 1080);
  assert.equal(Math.round(vw), 120);
  let s = 0;
  const positions: number[] = [];
  for (let i = 0; i < 15; i++) { s = rowScroll(s, i, 15, vw, ROW_GEOMETRY, PEEK); positions.push(s); }
  assert.equal(positions[0], 0);
  assert.equal(positions[1], 0);
  assert.ok(positions[4] > 0, "the 5th tile pushes the row");
  for (let i = 1; i < positions.length; i++) assert.ok(positions[i] >= positions[i - 1], "monotonic while moving right");
  const max = contentWidth(15, ROW_GEOMETRY) - vw;
  assert.equal(positions[14], max, "the last tile is fully visible at the end");
  // every focused tile is fully inside the window
  positions.forEach((sc, i) => {
    const left = ROW_PAD_START + i * (TILE_W + GAP) - sc;
    assert.ok(left >= 0 && left + TILE_W <= vw + 1e-9, `tile ${i} on screen`);
  });
  // going back left follows too
  let back = positions[14];
  for (let i = 14; i >= 0; i--) back = rowScroll(back, i, 15, vw, ROW_GEOMETRY, PEEK);
  assert.equal(back, 0);
});

test("rowScroll scales: ultrawide windows (more rem) scroll less", () => {
  const narrow = rowScroll(0, 6, 15, viewportWidthRem(1920, 1080), ROW_GEOMETRY, PEEK);
  const wide = rowScroll(0, 6, 15, viewportWidthRem(2560, 1080), ROW_GEOMETRY, PEEK);
  assert.ok(wide < narrow);
});

test("pageScroll: hero visible at the top, rows scroll the page up as you go down, hero again scrolls back", () => {
  const g = pageGeometry(4);
  assert.equal(pageScroll(0, "hero", VIEWPORT_H, g), 0);
  assert.equal(pageScroll(0, 0, VIEWPORT_H, g), 0, "row 0 fits below the hero");
  const r2 = pageScroll(0, 2, VIEWPORT_H, g);
  assert.ok(r2 > 0 && r2 < HERO_H + 2 * ROW_H, "row 2 scrolls the hero mostly away");
  const r3 = pageScroll(r2, 3, VIEWPORT_H, g);
  assert.ok(r3 > r2);
  assert.equal(pageScroll(r3, "hero", VIEWPORT_H, g), 0);
  const rowTop = HERO_H + 3 * ROW_H - r3;
  assert.ok(rowTop >= 0 && rowTop + ROW_H <= VIEWPORT_H + 1e-9, "the focused row is fully visible");
});

test("viewportWidthRem: 16:9 = 120rem at any resolution (1080p and 4K scale identically)", () => {
  assert.equal(Math.round(viewportWidthRem(1920, 1080)), 120);
  assert.equal(Math.round(viewportWidthRem(3840, 2160)), 120);
  assert.equal(Math.round(viewportWidthRem(1280, 720)), 120);
  assert.equal(viewportWidthRem(100, 0), 120);
});

// ===========================================================================
// Idle timer (fake clock)
// ===========================================================================

function fakeTimers() {
  let now = 0, id = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const deps: IdleDeps = {
    setTimeout(fn, ms) { const h = ++id; pending.set(h, { at: now + ms, fn }); return h; },
    clearTimeout(h) { pending.delete(h as number); },
  };
  return {
    deps,
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at; pending.delete(due[0]); due[1].fn();
      }
      now = target;
    },
    count: () => pending.size,
  };
}

test("idle: fires after the configured minutes of inactivity, once", () => {
  const t = fakeTimers(); let fired = 0;
  const idle = createIdleTimer({ getMinutes: () => 5, onIdle: () => fired++, deps: t.deps });
  idle.activity();
  t.advance(4 * 60_000 + 59_000);
  assert.equal(fired, 0);
  t.advance(2_000);
  assert.equal(fired, 1);
  t.advance(60 * 60_000);
  assert.equal(fired, 1, "does not fire again until there is new activity");
});

test("idle: every input restarts the countdown", () => {
  const t = fakeTimers(); let fired = 0;
  const idle = createIdleTimer({ getMinutes: () => 5, onIdle: () => fired++, deps: t.deps });
  idle.activity();
  for (let i = 0; i < 10; i++) { t.advance(4 * 60_000); idle.activity(); }
  assert.equal(fired, 0, "40 minutes of use never goes idle");
  t.advance(5 * 60_000);
  assert.equal(fired, 1);
});

test("idle: 0 minutes turns it off, and refresh() applies a changed setting immediately", () => {
  const t = fakeTimers(); let fired = 0; let minutes = 0;
  const idle = createIdleTimer({ getMinutes: () => minutes, onIdle: () => fired++, deps: t.deps });
  idle.activity();
  assert.equal(idle.isArmed(), false);
  t.advance(10 * 60_000);
  assert.equal(fired, 0);
  minutes = 2;
  idle.refresh();
  assert.ok(idle.isArmed());
  t.advance(2 * 60_000);
  assert.equal(fired, 1);
  minutes = 0;
  idle.activity();
  assert.equal(t.count(), 0, "turned off: nothing pending");
});

test("idle: NEVER counts while the launcher is hidden (another app in front); becoming visible starts a fresh countdown", () => {
  const t = fakeTimers(); let fired = 0;
  const idle = createIdleTimer({ getMinutes: () => 1, onIdle: () => fired++, deps: t.deps });
  idle.activity();
  idle.setVisible(false);
  assert.equal(idle.isArmed(), false);
  t.advance(60 * 60_000);
  assert.equal(fired, 0, "an hour behind a launched app: no screensaver");
  idle.activity(); // input while hidden must not re-arm either
  assert.equal(idle.isArmed(), false);
  idle.setVisible(true);
  t.advance(59_000);
  assert.equal(fired, 0, "fresh full countdown after returning");
  t.advance(2_000);
  assert.equal(fired, 1);
});

test("idle: stop() cancels for good", () => {
  const t = fakeTimers(); let fired = 0;
  const idle = createIdleTimer({ getMinutes: () => 1, onIdle: () => fired++, deps: t.deps });
  idle.activity();
  idle.stop();
  idle.activity();
  idle.setVisible(true);
  t.advance(10 * 60_000);
  assert.equal(fired, 0);
});

// ===========================================================================
// Pairing states
// ===========================================================================

const info = (over: Omit<Partial<LauncherInfo>, "pairing" | "network"> & { pairing?: Partial<LauncherInfo["pairing"]>; network?: Partial<LauncherInfo["network"]> } = {}): LauncherInfo => ({
  error: null, url: "http://192.168.1.5:8787", mdnsUrl: "http://couchui.local:8787", qr: "data:image/png;base64,x",
  devices: 1, connected: 0,
  ...over,
  pairing: { open: false, pin: null, expiresAt: null, ...over.pairing },
  network: { online: true, label: "Wi-Fi", ip: "192.168.1.5", ...over.network },
});

test("pairing: no phone EVER paired -> full-screen 'Connect your phone'", () => {
  const p = derivePairing(info({ devices: 0, pairing: { open: true, pin: "123456", expiresAt: null } }));
  assert.deepEqual(p.screen, { kind: "connect", online: true });
  assert.deepEqual(p.chips, { waitingForPhone: false, phoneConnected: false });
});

test("pairing: first run with no network still shows the screen, flagged offline (no useless QR)", () => {
  assert.deepEqual(derivePairing(info({ devices: 0, network: { online: false, label: null, ip: null } })).screen, { kind: "connect", online: false });
});

test("pairing: phones paired but none connected -> normal home + a small 'Waiting for your phone…' chip, NO PIN/QR screen", () => {
  const p = derivePairing(info({ devices: 2, connected: 0 }));
  assert.deepEqual(p.screen, { kind: "home" });
  assert.deepEqual(p.chips, { waitingForPhone: true, phoneConnected: false });
});

test("pairing: a phone is connected -> 'phone connected' indicator instead of the waiting chip", () => {
  const p = derivePairing(info({ devices: 2, connected: 1 }));
  assert.deepEqual(p.screen, { kind: "home" });
  assert.deepEqual(p.chips, { waitingForPhone: false, phoneConnected: true });
});

test("pairing: 'Pair new device' (pairing window open, phones exist) -> full-screen QR screen with a deadline", () => {
  const p = derivePairing(info({ devices: 2, connected: 1, pairing: { open: true, pin: "654321", expiresAt: 123456 } }));
  assert.deepEqual(p.screen, { kind: "pair-new", expiresAt: 123456, online: true });
  assert.deepEqual(p.chips, { waitingForPhone: false, phoneConnected: false });
});

test("pairing: pairing open WITHOUT a PIN never shows the screen; a port error stays on the home screen (red banner)", () => {
  assert.equal(derivePairing(info({ devices: 1, pairing: { open: true, pin: null } })).screen.kind, "home");
  const err = derivePairing(info({ devices: 0, error: "Port 8787 is already in use" }));
  assert.equal(err.screen.kind, "home");
  assert.deepEqual(err.chips, { waitingForPhone: false, phoneConnected: false });
});

test("pairing: before the first info arrives nothing is shown", () => {
  const p = derivePairing(null);
  assert.equal(p.screen.kind, "home");
  assert.deepEqual(p.chips, { waitingForPhone: false, phoneConnected: false });
});

test("formatCountdown: m:ss, never negative, empty without a deadline", () => {
  assert.equal(formatCountdown(120_000, 0), "2:00");
  assert.equal(formatCountdown(120_000, 15_000), "1:45");
  assert.equal(formatCountdown(61_000, 0), "1:01");
  assert.equal(formatCountdown(500, 0), "0:01");
  assert.equal(formatCountdown(0, 5000), "0:00");
  assert.equal(formatCountdown(null, 0), "");
});

// ===========================================================================
// Settings: model + D-pad navigation
// ===========================================================================

const data = (over: Partial<SettingsData> = {}): SettingsData => ({
  displays: [{ id: 1, label: "Built-in", width: 1920, height: 1080, primary: true, current: true }, { id: 2, label: "LG TV", width: 3840, height: 2160, primary: false, current: false }],
  devices: [{ label: "iPhone", createdAt: 1 }],
  wallpapers: [{ id: "builtin:aurora", name: "Aurora" }, { id: "builtin:ember", name: "Ember" }, { id: "file:a.png", name: "a", url: "couch://wallpaper/a.png" }],
  about: { version: "0.2.0", packaged: false, dataDir: "C:\\d", configFile: "c", appsFile: "C:\\apps.json", wallpapersDir: "w" },
  ui: DEFAULT_UI,
  armed: null,
  ...over,
});

test("settings: the menu has exactly the six required sections, in order", () => {
  assert.deepEqual(MENU.map((m) => m.title), ["Display", "Wallpaper", "Screensaver", "Devices", "Add app", "About / Exit"]);
  assert.deepEqual(buildSections(data()).map((s) => s.title), MENU.map((m) => m.title));
});

test("settings: Display lists every display with its resolution, marks the current one, and has Reduce effects", () => {
  const items = buildSections(data())[0].items;
  assert.match((items[0] as { label: string }).label, /Built-in \(1920 × 1080\)/);
  assert.equal((items[0] as { hint?: string }).hint, "Launcher is here");
  assert.equal((items[1] as { hint?: string }).hint, "Move launcher here");
  assert.ok(items.some((i) => i.id === "display-reset"));
  const fx = items.find((i) => i.id === "reduce-fx") as { value: string };
  assert.equal(fx.value, "Off");
  assert.equal((buildSections(data({ ui: { ...DEFAULT_UI, reduceEffects: true } }))[0].items.find((i) => i.id === "reduce-fx") as { value: string }).value, "On");
});

test("settings: Wallpaper shows 'Wallpaper' in single mode and 'Change every N' in rotate mode", () => {
  const single = buildSections(data())[1].items.map((i) => i.id);
  assert.ok(single.includes("wp-pick") && !single.includes("wp-minutes"));
  const rotate = buildSections(data({ ui: { ...DEFAULT_UI, wallpaper: { mode: "rotate", id: "builtin:aurora", minutes: 5 } } }))[1].items;
  assert.ok(rotate.some((i) => i.id === "wp-minutes" && (i as { value: string }).value === "5 minutes") && !rotate.some((i) => i.id === "wp-pick"));
});

test("settings: Devices lists phones, offers Pair new device + Forget all, and Forget shows its armed text", () => {
  const items = buildSections(data())[3].items;
  assert.ok(items.some((i) => i.id === "dev:0" && i.kind === "info" && i.label === "iPhone"));
  assert.ok(items.some((i) => i.id === "dev-pair") && items.some((i) => i.id === "dev-forget"));
  const armed = buildSections(data({ armed: "dev-forget" }))[3].items.find((i) => i.id === "dev-forget") as { label: string; armed?: boolean };
  assert.match(armed.label, /Press OK again/);
  assert.equal(armed.armed, true);
  assert.ok(buildSections(data({ devices: [] }))[3].items.some((i) => i.id === "dev-none"));
});

test("settings: Add app is a stub that says M7; About has version + Exit (confirm text when armed)", () => {
  assert.match((buildSections(data())[4].items[0] as { label: string }).label, /coming in M7/);
  const about = buildSections(data())[5].items;
  assert.ok(about.some((i) => i.id === "about-version" && (i as { value?: string }).value === "version 0.2.0"));
  assert.equal((about.find((i) => i.id === "exit") as { label: string }).label, "Exit launcher");
  assert.match((buildSections(data({ armed: "exit" }))[5].items.find((i) => i.id === "exit") as { label: string }).label, /Press OK again to exit/);
});

test("settings: choice helpers", () => {
  assert.equal(nextChoice([0, 1, 2, 5], 2, 1), 5);
  assert.equal(nextChoice([0, 1, 2, 5], 5, 1), 0, "wraps");
  assert.equal(nextChoice([0, 1, 2, 5], 0, -1), 5, "wraps backwards");
  assert.equal(nextChoice([0, 1], 99, 1), 1, "unknown current starts from the first");
  assert.equal(minutesLabel(0), "Off");
  assert.equal(minutesLabel(1), "1 minute");
  assert.equal(minutesLabel(10), "10 minutes");
});

const secs = () => buildSections(data());
const lastFocusable = (items: readonly { kind: string }[]) => items.map((i, n) => (i.kind === "info" ? -1 : n)).filter((n) => n >= 0).pop() ?? -1;
const menu = (section: number): SettingsFocus => ({ zone: "menu", section });
const pane = (section: number, item: number): SettingsFocus => ({ zone: "pane", section, item });

test("settings nav: in the menu, up/down change section (clamped), right/OK enter the pane, back closes", () => {
  assert.deepEqual(stepSettings(secs(), menu(0), "down").focus, menu(1));
  assert.deepEqual(stepSettings(secs(), menu(0), "up").focus, menu(0));
  assert.deepEqual(stepSettings(secs(), menu(5), "down").focus, menu(5));
  assert.deepEqual(stepSettings(secs(), menu(0), "right").focus, pane(0, 0));
  assert.deepEqual(stepSettings(secs(), menu(0), "ok").focus, pane(0, 0));
  assert.deepEqual(stepSettings(secs(), menu(0), "left").focus, menu(0));
  assert.deepEqual(stepSettings(secs(), menu(2), "back").effect, { type: "close" });
});

test("settings nav: in a pane, up/down skip info rows and stop at the ends", () => {
  const s = secs();
  const display = s[0].items; // action, action, action(reset), choice(reduce), info
  let f: SettingsFocus = pane(0, 0);
  const visited: number[] = [];
  for (let i = 0; i < 8; i++) { f = stepSettings(s, f, "down").focus; visited.push((f as { item: number }).item); }
  assert.ok(visited.every((i) => display[i].kind !== "info"), "never lands on an info row");
  assert.equal(visited[visited.length - 1], display.findIndex((i) => i.id === "reduce-fx"), "stops at the last focusable item");
  assert.deepEqual(stepSettings(s, pane(0, 0), "up").focus, pane(0, 0));
});

test("settings nav: left/right on a CHOICE adjusts it; OK on a choice advances it; OK on an action activates it", () => {
  const s = secs();
  const fxIndex = s[0].items.findIndex((i) => i.id === "reduce-fx");
  assert.deepEqual(stepSettings(s, pane(0, fxIndex), "right").effect, { type: "adjust", section: 0, item: fxIndex, dir: 1 });
  assert.deepEqual(stepSettings(s, pane(0, fxIndex), "left").effect, { type: "adjust", section: 0, item: fxIndex, dir: -1 });
  assert.deepEqual(stepSettings(s, pane(0, fxIndex), "ok").effect, { type: "adjust", section: 0, item: fxIndex, dir: 1 });
  assert.deepEqual(stepSettings(s, pane(0, 0), "ok").effect, { type: "activate", section: 0, item: 0 });
});

test("settings nav: left on an action, and back anywhere in a pane, return to the menu (same section)", () => {
  const s = secs();
  assert.deepEqual(stepSettings(s, pane(3, 1), "left").focus, menu(3));
  assert.deepEqual(stepSettings(s, pane(3, 1), "back").focus, menu(3));
  assert.equal(stepSettings(s, pane(3, 1), "back").effect, undefined, "back from a pane does NOT leave Settings");
  assert.deepEqual(stepSettings(s, pane(0, 0), "right").focus, pane(0, 0), "right on an action does nothing");
});

test("settings nav: a section with only info rows can't be entered", () => {
  const onlyInfo = [{ id: "addapp", title: "Add app", items: [{ id: "x", kind: "info", label: "hi" }] }] as never;
  assert.deepEqual(stepSettings(onlyInfo, menu(0), "right").focus, menu(0));
});

test("settings nav: clampSettingsFocus repairs a focus after items change (wallpaper mode switch)", () => {
  const s = secs();
  assert.deepEqual(clampSettingsFocus(s, pane(1, 99)), pane(1, lastFocusable(s[1].items)));
  assert.deepEqual(clampSettingsFocus(s, pane(1, 3)), pane(1, 2), "info row -> next focusable");
  assert.deepEqual(clampSettingsFocus(s, menu(99)), menu(5));
  assert.deepEqual(clampSettingsFocus([], menu(0)), menu(0));
});

// ===========================================================================
// UI settings validation
// ===========================================================================

test("uiSettings: defaults are 5 minute screensaver, single aurora wallpaper, effects on", () => {
  assert.deepEqual(DEFAULT_UI, { wallpaper: { mode: "single", id: "builtin:aurora", minutes: 10 }, screensaverMinutes: 5, reduceEffects: false, lastLaunchedId: null });
});

test("uiSettings: garbage in -> safe values out (unknown keys dropped, numbers snapped to allowed choices)", () => {
  assert.deepEqual(sanitizeUi(null), DEFAULT_UI);
  assert.deepEqual(sanitizeUi("x"), DEFAULT_UI);
  const s = sanitizeUi({ screensaverMinutes: 7, reduceEffects: "yes", wallpaper: { mode: "weird", id: "../../x", minutes: 999 }, evil: true, lastLaunchedId: "../..", extra: { a: 1 } });
  assert.equal(s.screensaverMinutes, 5, "7 snaps to the nearest allowed value (5)");
  assert.equal(s.reduceEffects, false);
  assert.deepEqual(s.wallpaper, { mode: "single", id: "builtin:aurora", minutes: 30 });
  assert.equal(s.lastLaunchedId, null);
  assert.ok(!("evil" in s));
  assert.equal(sanitizeUi({ screensaverMinutes: -3 }).screensaverMinutes, 0, "negative -> Off");
  assert.equal(sanitizeUi({ screensaverMinutes: NaN }).screensaverMinutes, 5);
  assert.equal(sanitizeUi({ screensaverMinutes: 0 }).screensaverMinutes, 0);
});

test("uiSettings: wallpaper ids must be builtin:<slug> or file:<plain name>", () => {
  for (const id of ["builtin:aurora", "file:Sunset.png", "file:my pic (1).jpg"]) assert.equal(sanitizeUi({ wallpaper: { id } }).wallpaper.id, id);
  for (const id of ["file:../x.png", "file:a/b.png", "file:a\\b.png", "http://evil", "builtin:", "", "file:", "javascript:alert(1)"]) assert.equal(sanitizeUi({ wallpaper: { id } }).wallpaper.id, "builtin:aurora", id);
});

test("uiSettings: mergeUi merges a partial patch (deeply for wallpaper) and keeps everything else", () => {
  const base = { ...DEFAULT_UI, lastLaunchedId: "netflix", screensaverMinutes: 10 };
  const m = mergeUi(base, { wallpaper: { mode: "rotate" } });
  assert.deepEqual(m.wallpaper, { mode: "rotate", id: "builtin:aurora", minutes: 10 });
  assert.equal(m.screensaverMinutes, 10);
  assert.equal(m.lastLaunchedId, "netflix");
  assert.equal(mergeUi(base, { reduceEffects: true }).reduceEffects, true);
  assert.equal(mergeUi(base, { lastLaunchedId: "vlc" }).lastLaunchedId, "vlc");
  assert.equal(mergeUi(base, { lastLaunchedId: null }).lastLaunchedId, null);
  assert.deepEqual(mergeUi(base, null), base);
  assert.deepEqual(mergeUi(base, { __proto__: { polluted: 1 } } as never), base);
});

// ===========================================================================
// Clock
// ===========================================================================

test("clock: formats time and a long date; next-minute timer lands just after the boundary", () => {
  const c = formatClock(new Date(2026, 10, 17, 21, 5), "en-US");
  assert.equal(c.time, "9:05 PM");
  assert.equal(c.date, "Tuesday, November 17");
  assert.equal(msToNextMinute(0), 60_050);
  assert.equal(msToNextMinute(59_999), 51);
  assert.ok(msToNextMinute(123_456) > 0 && msToNextMinute(123_456) <= 60_050);
});
