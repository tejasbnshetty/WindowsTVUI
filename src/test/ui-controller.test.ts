import { test } from "node:test";
import * as assert from "node:assert/strict";
import { createController, type Controller, type UiState } from "../ui/controller";
import type { IdleDeps } from "../ui/idle";
import type { AboutInfo, DeviceView, DisplayView, LauncherInfo, LaunchResult, PublicApp, TvApi, UiSettings, WallpaperFile } from "../ui/types";
import { DEFAULT_UI, mergeUi } from "../uiSettings";

// ---------------------------------------------------------------------------
// Mock bridge + fake clock: nothing real is touched.
// ---------------------------------------------------------------------------

const app = (id: string, name: string, category: string, extra: Partial<PublicApp> = {}): PublicApp =>
  ({ id, name, category, type: "url", color: "#336699", iconPath: null, imageUrl: null, installed: null, ...extra });

const APPS: PublicApp[] = [
  app("netflix", "Netflix", "Streaming"), app("youtube", "YouTube", "Streaming"), app("disney", "Disney+", "Streaming"),
  app("spotify", "Spotify", "Music"), app("applemusic", "Apple Music", "Music"),
  app("vlc", "VLC", "Local & Media", { type: "exe", installed: false }), app("kodi", "Kodi", "Local & Media", { type: "exe" }),
  app("browser", "Browser", "Apps"),
];

const info = (over: Partial<LauncherInfo> = {}): LauncherInfo => ({
  error: null, url: "http://192.168.1.5:8787", mdnsUrl: null, qr: "data:image/png;base64,x",
  pairing: { open: false, pin: null, expiresAt: null }, devices: 1, connected: 0,
  network: { online: true, label: "Wi-Fi", ip: "192.168.1.5" }, ...over,
});

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
  };
}

interface Mock {
  tv: TvApi;
  calls: string[];
  ui: UiSettings;
  pushInfo(i: LauncherInfo): void;
  nav(a: string): void;
  launchResults: Record<string, LaunchResult>;
  info: LauncherInfo;
  devices: DeviceView[];
  displays: DisplayView[];
  chooseResult: boolean;
  wallpapers: WallpaperFile[];
}

function mockTv(over: Partial<Pick<Mock, "info" | "ui" | "devices" | "displays" | "wallpapers">> = {}): Mock {
  const calls: string[] = [];
  let infoCb: (i: LauncherInfo) => void = () => {};
  let navCb: (a: string) => void = () => {};
  const m: Mock = {
    calls,
    ui: over.ui ?? DEFAULT_UI,
    info: over.info ?? info(),
    devices: over.devices ?? [{ label: "iPhone", createdAt: 1 }],
    displays: over.displays ?? [{ id: 1, label: "Built-in", width: 1920, height: 1080, primary: true, current: true }, { id: 2, label: "LG TV", width: 3840, height: 2160, primary: false, current: false }],
    wallpapers: over.wallpapers ?? [],
    chooseResult: true,
    launchResults: {},
    pushInfo: (i) => infoCb(i),
    nav: (a) => navCb(a),
    tv: undefined as unknown as TvApi,
  };
  m.tv = {
    getApps: async () => APPS,
    getUi: async () => m.ui,
    setUi: async (patch) => { calls.push(`setUi:${JSON.stringify(patch)}`); m.ui = mergeUi(m.ui, patch); return m.ui; },
    getWallpapers: async () => m.wallpapers,
    getRemoteInfo: async () => m.info,
    onInfo: (cb) => { infoCb = cb; },
    onNav: (cb) => { navCb = cb; },
    launch: async (id) => { calls.push(`launch:${id}`); return m.launchResults[id] ?? { ok: true, lastLaunchedId: id }; },
    getDevices: async () => m.devices,
    forgetDevices: async () => { calls.push("forget"); m.devices = []; },
    openPairing: () => { calls.push("openPairing"); },
    closePairing: () => { calls.push("closePairing"); },
    getDisplays: async () => m.displays,
    chooseDisplay: async (id) => { calls.push(`chooseDisplay:${id}`); return m.chooseResult; },
    getAbout: async () => ({ version: "0.2.0", packaged: false, dataDir: "C:\\data", configFile: "c", appsFile: "C:\\apps.json", wallpapersDir: "w" }) as AboutInfo,
    openFolder: (w) => { calls.push(`openFolder:${w}`); },
    quit: () => { calls.push("quit"); },
  };
  return m;
}

async function setup(over: Parameters<typeof mockTv>[0] = {}) {
  const mock = mockTv(over);
  const timers = fakeTimers();
  const c = createController({ tv: mock.tv, timers: timers.deps, now: () => 1000, random: () => 0.5 });
  await c.init();
  const flush = () => new Promise((r) => setImmediate(r));
  return { c, mock, timers, flush, s: (): UiState => c.getState() };
}

const press = async (c: Controller, ...keys: Array<Parameters<Controller["input"]>[0]>) => { for (const k of keys) c.input(k); await new Promise((r) => setImmediate(r)); };
const focused = (s: UiState): string => {
  if (s.focus.zone === "hero") return "hero";
  const item = s.rows[s.focus.row].items[s.focus.col];
  return item.kind === "settings" ? "Settings" : item.app.name;
};

// ===========================================================================
// Focus navigation through the real controller
// ===========================================================================

test("controller: starts ready with rows built from the apps and focus on the first tile", async () => {
  const { s } = await setup();
  assert.equal(s().ready, true);
  assert.deepEqual(s().rows.map((r) => r.title), ["Streaming", "Music", "Local & Media", "Apps"]);
  assert.equal(focused(s()), "Netflix");
});

test("controller: all seven actions work (up/down/left/right/ok/back/home)", async () => {
  const { c, s, mock } = await setup();
  await press(c, "right", "right");
  assert.equal(focused(s()), "Disney+");
  await press(c, "down");
  assert.equal(focused(s()), "Apple Music", "column 2 clamps to the 2-tile Music row");
  await press(c, "left");
  assert.equal(focused(s()), "Spotify");
  await press(c, "up", "up");
  assert.equal(focused(s()), "hero");
  await press(c, "down");
  assert.equal(focused(s()), "Netflix", "back to row 0 in the remembered column (0)");
  await press(c, "right", "ok");
  assert.deepEqual(mock.calls, ["launch:youtube"], "OK launches the focused app");
  await press(c, "down", "down", "down");
  await press(c, "back");
  assert.equal(focused(s()), "Netflix", "back returns to the first tile");
  await press(c, "down", "home");
  assert.equal(focused(s()), "Netflix", "home too");
});

test("controller: remote nav messages from the phone drive the same logic, unknown ones are ignored", async () => {
  const { s, mock } = await setup();
  mock.nav("right");
  assert.equal(focused(s()), "YouTube");
  mock.nav("down");
  assert.equal(focused(s()), "Apple Music");
  mock.nav("explode");
  mock.nav("");
  assert.equal(focused(s()), "Apple Music");
  mock.nav("ok");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(mock.calls, ["launch:applemusic"]);
});

test("controller: the hero is reachable with UP, and OK on a welcome hero just focuses the first row", async () => {
  const { c, s, mock } = await setup();
  await press(c, "up");
  assert.equal(focused(s()), "hero");
  await press(c, "ok");
  assert.deepEqual(mock.calls, [], "no last-launched app: nothing launched");
  assert.equal(focused(s()), "Netflix");
});

test("controller: OK on the hero re-opens the last launched app", async () => {
  const { c, mock } = await setup({ ui: { ...DEFAULT_UI, lastLaunchedId: "kodi" } });
  await press(c, "up", "ok");
  assert.deepEqual(mock.calls, ["launch:kodi"]);
});

test("controller: clicking a tile focuses and launches it", async () => {
  const { c, s, mock } = await setup();
  c.clickTile(1, 1);
  await new Promise((r) => setImmediate(r));
  assert.equal(focused(s()), "Apple Music");
  assert.deepEqual(mock.calls, ["launch:applemusic"]);
});

// ===========================================================================
// Launching, "Not installed", hero
// ===========================================================================

test("controller: a successful launch updates the hero to that app", async () => {
  const { c, s } = await setup();
  assert.equal(s().ui.lastLaunchedId, null);
  await press(c, "ok");
  assert.equal(s().ui.lastLaunchedId, "netflix");
});

test("controller: a missing app shows a clear 'Not installed' toast instead of failing, and does NOT become the hero", async () => {
  const { c, s, mock } = await setup();
  mock.launchResults.vlc = { ok: false, code: "not-installed", message: "VLC isn't installed (not found: C:\\Program Files\\VideoLAN\\VLC\\vlc.exe)" };
  c.clickTile(2, 0);
  await new Promise((r) => setImmediate(r));
  assert.equal(s().toast?.kind, "error");
  assert.match(s().toast!.text, /VLC isn't installed/);
  assert.equal(s().ui.lastLaunchedId, null);
});

test("controller: toasts disappear by themselves", async () => {
  const { c, s, mock, timers } = await setup();
  mock.launchResults.netflix = { ok: false, code: "failed", message: "Could not open Netflix" };
  await press(c, "ok");
  assert.ok(s().toast);
  timers.advance(5000);
  assert.equal(s().toast, null);
});

test("controller: a launch that throws is reported, and a second OK while one is in flight is ignored", async () => {
  const { c, s, mock } = await setup();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  mock.tv.launch = async (id) => { mock.calls.push(`launch:${id}`); await gate; return { ok: true, lastLaunchedId: id }; };
  c.input("ok"); c.input("ok"); c.input("ok");
  release();
  await new Promise((r) => setImmediate(r));
  assert.equal(mock.calls.filter((x) => x.startsWith("launch")).length, 1, "double-press launches once");
  mock.tv.launch = async () => { throw new Error("ipc down"); };
  c.input("ok");
  await new Promise((r) => setImmediate(r));
  assert.match(s().toast!.text, /Could not open/);
});

// ===========================================================================
// Settings screen through the controller
// ===========================================================================

async function openSettings(t: Awaited<ReturnType<typeof setup>>) {
  await press(t.c, "down", "down", "down", "right"); // Apps row: Browser -> Settings tile
  assert.equal(focused(t.s()), "Settings");
  await press(t.c, "ok");
  await t.flush();
}

test("controller: OK on the Settings tile opens Settings and loads displays, devices and about", async () => {
  const t = await setup();
  await openSettings(t);
  assert.equal(t.s().screen, "settings");
  assert.equal(t.s().displays.length, 2);
  assert.equal(t.s().devices.length, 1);
  assert.equal(t.s().about?.version, "0.2.0");
  assert.deepEqual(t.s().settingsFocus, { zone: "menu", section: 0 });
});

test("controller: Back from the menu leaves Settings; Home leaves from anywhere", async () => {
  const t = await setup();
  await openSettings(t);
  await press(t.c, "right", "back");
  assert.equal(t.s().screen, "settings", "back from the pane only returns to the menu");
  await press(t.c, "back");
  assert.equal(t.s().screen, "home");
  await openSettings(t);
  await press(t.c, "right", "down", "home");
  assert.equal(t.s().screen, "home");
  assert.equal(focused(t.s()), "Netflix");
});

test("controller: Reduce effects toggles and is saved through the bridge", async () => {
  const t = await setup();
  await openSettings(t);
  await press(t.c, "right");
  while (!(t.c.sections()[0].items[(t.s().settingsFocus as { item: number }).item]?.id === "reduce-fx")) await press(t.c, "down");
  await press(t.c, "right");
  await t.flush();
  assert.equal(t.s().ui.reduceEffects, true);
  assert.ok(t.mock.calls.includes('setUi:{"reduceEffects":true}'));
  await press(t.c, "left");
  await t.flush();
  assert.equal(t.s().ui.reduceEffects, false);
});

test("controller: wallpaper mode / choice / rotate interval are changed with left-right and saved", async () => {
  const t = await setup({ wallpapers: [{ name: "Sunset.png", url: "couch://wallpaper/Sunset.png" }] });
  await openSettings(t);
  await press(t.c, "down", "right"); // Wallpaper section, enter pane (Mode)
  await press(t.c, "down", "right"); // Wallpaper choice -> next
  await t.flush();
  assert.equal(t.s().ui.wallpaper.id, "builtin:ember");
  await press(t.c, "up", "right"); // Mode -> rotate
  await t.flush();
  assert.equal(t.s().ui.wallpaper.mode, "rotate");
  await press(t.c, "down", "right"); // Change every: 10 -> 15
  await t.flush();
  assert.equal(t.s().ui.wallpaper.minutes, 15);
});

test("controller: wallpaper rotation advances every N minutes (fake clock)", async () => {
  const t = await setup({ ui: { ...DEFAULT_UI, wallpaper: { mode: "rotate", id: "builtin:aurora", minutes: 2 } } });
  const n = t.s().wallpapers.length;
  assert.equal(t.s().rotateIndex, 0);
  t.timers.advance(2 * 60_000);
  assert.equal(t.s().rotateIndex, 1 % n);
  t.timers.advance(2 * 60_000);
  assert.equal(t.s().rotateIndex, 2 % n);
});

test("controller: screensaver minutes cycle Off <-> 1 <-> 2 <-> 5 ... and are saved", async () => {
  const t = await setup();
  await openSettings(t);
  await press(t.c, "down", "down", "right"); // Screensaver pane
  assert.equal(t.s().ui.screensaverMinutes, 5);
  await press(t.c, "right"); await t.flush();
  assert.equal(t.s().ui.screensaverMinutes, 10);
  await press(t.c, "left", "left", "left", "left"); await t.flush();
  assert.equal(t.s().ui.screensaverMinutes, 0, "Off");
  await press(t.c, "left"); await t.flush();
  assert.equal(t.s().ui.screensaverMinutes, 30, "wraps");
});

test("controller: choosing a display calls the bridge and refreshes the list; an unplugged one explains itself", async () => {
  const t = await setup();
  await openSettings(t);
  await press(t.c, "right", "down", "ok"); // second display
  await t.flush();
  assert.ok(t.mock.calls.includes("chooseDisplay:2"));
  t.mock.chooseResult = false;
  await press(t.c, "ok");
  await t.flush();
  assert.match(t.s().toast!.text, /isn't connected/);
  await press(t.c, "down", "ok");
  await t.flush();
  assert.ok(t.mock.calls.includes("chooseDisplay:null"), "'Use the default display'");
});

test("controller: 'Forget all devices' needs OK twice; moving away or waiting cancels it", async () => {
  const t = await setup();
  await openSettings(t);
  await press(t.c, "down", "down", "down", "right", "down", "down"); // Devices pane: Pair, Forget (info row skipped)
  const forgetIdx = t.c.sections()[3].items.findIndex((i) => i.id === "dev-forget");
  assert.equal((t.s().settingsFocus as { item: number }).item, forgetIdx);
  await press(t.c, "ok");
  assert.equal(t.s().armed, "dev-forget");
  assert.ok(!t.mock.calls.includes("forget"), "first OK does nothing destructive");
  await press(t.c, "up");
  assert.equal(t.s().armed, null, "moving away disarms");
  await press(t.c, "down", "ok");
  assert.equal(t.s().armed, "dev-forget");
  t.timers.advance(5000);
  assert.equal(t.s().armed, null, "times out");
  await press(t.c, "ok", "ok");
  await t.flush();
  assert.ok(t.mock.calls.includes("forget"), "second OK forgets");
  assert.equal(t.s().devices.length, 0);
  assert.match(t.s().toast!.text, /forgotten/);
});

test("controller: 'Pair new device' opens pairing; 'Exit launcher' needs OK twice and then quits", async () => {
  const t = await setup();
  await openSettings(t);
  await press(t.c, "down", "down", "down", "right"); // Devices pane: first focusable row is Pair new device (phones are info rows)
  await press(t.c, "ok");
  assert.ok(t.mock.calls.includes("openPairing"));
  await press(t.c, "left", "down", "down", "right", "down"); // About / Exit pane -> Open data folder, Exit
  const exitIdx = t.c.sections()[5].items.findIndex((i) => i.id === "exit");
  while ((t.s().settingsFocus as { item: number }).item !== exitIdx) await press(t.c, "down");
  await press(t.c, "ok");
  assert.ok(!t.mock.calls.includes("quit"));
  assert.equal(t.s().armed, "exit");
  await press(t.c, "ok");
  assert.ok(t.mock.calls.includes("quit"));
});

test("controller: 'Open wallpapers folder' and 'Open data folder' only ever name the two fixed folders", async () => {
  const t = await setup();
  await openSettings(t);
  await press(t.c, "down", "right", "down", "down"); // wallpaper pane -> folder action
  await press(t.c, "ok");
  assert.ok(t.mock.calls.includes("openFolder:wallpapers"));
});

// ===========================================================================
// Screensaver
// ===========================================================================

test("screensaver: starts after the configured idle minutes and shows a slideshow", async () => {
  const t = await setup({ wallpapers: [{ name: "a.png", url: "couch://wallpaper/a.png" }, { name: "b.png", url: "couch://wallpaper/b.png" }] });
  t.timers.advance(4 * 60_000);
  assert.equal(t.s().screensaver, false);
  t.timers.advance(61_000);
  assert.equal(t.s().screensaver, true);
  assert.deepEqual(t.s().slideshow.map((s) => s.name).sort(), ["a", "b"], "the user's pictures, not the built-ins");
});

test("screensaver: with no pictures it falls back to the built-in wallpapers (never empty)", async () => {
  const t = await setup();
  t.timers.advance(5 * 60_000 + 1);
  assert.equal(t.s().screensaver, true);
  assert.equal(t.s().slideshow.length, 4);
});

test("screensaver: the FIRST input after it only wakes it and triggers NO action (every kind of input)", async () => {
  for (const action of ["ok", "right", "down", "up", "left", "back", "home"] as const) {
    const t = await setup();
    const before = t.s().focus;
    t.timers.advance(5 * 60_000 + 1);
    assert.equal(t.s().screensaver, true);
    t.c.input(action);
    await t.flush();
    assert.equal(t.s().screensaver, false, `${action} wakes it`);
    assert.deepEqual(t.s().focus, before, `${action}: focus did not move`);
    assert.deepEqual(t.mock.calls, [], `${action}: nothing was launched`);
    assert.equal(t.s().screen, "home");
  }
});

test("screensaver: remote nav messages from the phone wake it without acting", async () => {
  const t = await setup();
  t.timers.advance(5 * 60_000 + 1);
  t.mock.nav("ok");
  await t.flush();
  assert.equal(t.s().screensaver, false);
  assert.deepEqual(t.mock.calls, []);
});

test("screensaver: the Esc key only wakes it (does not exit), the P key does not open pairing, mouse movement wakes it", async () => {
  let t = await setup();
  t.timers.advance(5 * 60_000 + 1);
  t.c.exitKey();
  assert.equal(t.s().screensaver, false);
  assert.ok(!t.mock.calls.includes("quit"), "first Esc only wakes");
  t.c.exitKey();
  assert.ok(t.mock.calls.includes("quit"), "second Esc exits as usual");

  t = await setup();
  t.timers.advance(5 * 60_000 + 1);
  t.c.pairKey();
  assert.equal(t.s().screensaver, false);
  assert.ok(!t.mock.calls.includes("openPairing"));

  t = await setup();
  t.timers.advance(5 * 60_000 + 1);
  t.c.activity();
  assert.equal(t.s().screensaver, false, "mouse / any other key wakes it");
  assert.equal(t.s().focus.zone, "row");
});

test("screensaver: a click while it plays only wakes it", async () => {
  const t = await setup();
  t.timers.advance(5 * 60_000 + 1);
  t.c.clickTile(0, 0);
  await t.flush();
  assert.equal(t.s().screensaver, false);
  assert.deepEqual(t.mock.calls, []);
});

test("screensaver: after waking, the idle countdown starts over", async () => {
  const t = await setup();
  t.timers.advance(5 * 60_000 + 1);
  t.c.input("ok");
  t.timers.advance(4 * 60_000);
  assert.equal(t.s().screensaver, false);
  t.timers.advance(61_000);
  assert.equal(t.s().screensaver, true);
});

test("screensaver: NEVER while another app is in front (launcher hidden); hiding also stops one that is playing", async () => {
  const t = await setup();
  t.c.setVisible(false);
  t.timers.advance(60 * 60_000);
  assert.equal(t.s().screensaver, false, "an hour behind a launched app: nothing");
  t.c.setVisible(true);
  t.timers.advance(5 * 60_000 + 1);
  assert.equal(t.s().screensaver, true);
  t.c.setVisible(false);
  assert.equal(t.s().screensaver, false, "hidden launcher never comes back mid-screensaver");
});

test("screensaver: can be turned off (0 minutes) and the setting applies immediately", async () => {
  const t = await setup({ ui: { ...DEFAULT_UI, screensaverMinutes: 0 } });
  t.timers.advance(6 * 60 * 60_000);
  assert.equal(t.s().screensaver, false);
});

test("screensaver: changing the delay in Settings re-arms the timer", async () => {
  const t = await setup();
  await openSettings(t);
  await press(t.c, "down", "down", "right", "left", "left", "left"); // 5 -> 2 -> 1 -> Off? (left x3 from 5: 2,1,Off)
  await t.flush();
  assert.equal(t.s().ui.screensaverMinutes, 0);
  t.timers.advance(60 * 60_000);
  assert.equal(t.s().screensaver, false);
});

test("screensaver: 'Preview now' starts it straight away, and it is not interrupted by the pairing screen rule", async () => {
  const t = await setup();
  await openSettings(t);
  await press(t.c, "down", "down", "right", "down"); // Screensaver pane -> Preview now
  await press(t.c, "ok");
  assert.equal(t.s().screensaver, true);
  assert.equal(t.s().screen, "home", "Settings closed behind it");
});

test("screensaver: does not start while a pairing screen is up (someone is reading a PIN)", async () => {
  const t = await setup({ info: info({ devices: 0, pairing: { open: true, pin: "123456", expiresAt: null } }) });
  t.timers.advance(5 * 60_000 + 1);
  assert.equal(t.s().screensaver, false);
});

// ===========================================================================
// Pairing UX through the controller
// ===========================================================================

test("pairing: first run (no phone ever paired) -> connect screen; navigation and OK are ignored on it", async () => {
  const t = await setup({ info: info({ devices: 0, pairing: { open: true, pin: "123456", expiresAt: null } }) });
  assert.equal(t.c.pairing().screen.kind, "connect");
  const before = t.s().focus;
  await press(t.c, "down", "right", "ok", "back", "home");
  assert.deepEqual(t.s().focus, before);
  assert.deepEqual(t.mock.calls, [], "nothing launched behind the connect screen");
});

test("pairing: paired phones, none connected -> waiting chip, no PIN/QR screen; connecting swaps the chip and toasts", async () => {
  const t = await setup({ info: info({ devices: 2, connected: 0 }) });
  assert.equal(t.c.pairing().screen.kind, "home");
  assert.deepEqual(t.c.pairing().chips, { waitingForPhone: true, phoneConnected: false });
  t.mock.pushInfo(info({ devices: 2, connected: 1 }));
  assert.deepEqual(t.c.pairing().chips, { waitingForPhone: false, phoneConnected: true });
  assert.equal(t.s().toast?.text, "Phone connected");
  t.mock.pushInfo(info({ devices: 2, connected: 0 }));
  assert.deepEqual(t.c.pairing().chips, { waitingForPhone: true, phoneConnected: false });
});

test("pairing: 'Pair new device' info flips to the full-screen QR screen; Back/Home cancel it via the bridge; the timeout returns home", async () => {
  const t = await setup();
  t.mock.pushInfo(info({ devices: 2, pairing: { open: true, pin: "654321", expiresAt: 999999 } }));
  assert.equal(t.c.pairing().screen.kind, "pair-new");
  await press(t.c, "down", "ok");
  assert.deepEqual(t.mock.calls, [], "other keys do nothing while pairing");
  await press(t.c, "back");
  assert.deepEqual(t.mock.calls, ["closePairing"]);
  t.mock.pushInfo(info({ devices: 2 })); // the main process closed it (cancel, success or the 2-minute timeout)
  assert.equal(t.c.pairing().screen.kind, "home");
});

test("pairing: forgetting every phone makes the first-run connect screen appear again", async () => {
  const t = await setup();
  t.mock.pushInfo(info({ devices: 0, pairing: { open: true, pin: "111111", expiresAt: null } }));
  assert.equal(t.c.pairing().screen.kind, "connect");
});

test("pairing: the P key asks the main process to open pairing", async () => {
  const t = await setup();
  t.c.pairKey();
  assert.deepEqual(t.mock.calls, ["openPairing"]);
});

test("controller: the Esc key quits", async () => {
  const t = await setup();
  t.c.exitKey();
  assert.deepEqual(t.mock.calls, ["quit"]);
});

test("controller: subscribers are notified, can unsubscribe, and dispose stops everything", async () => {
  const t = await setup();
  let n = 0;
  const off = t.c.subscribe(() => n++);
  t.c.input("right");
  assert.ok(n > 0);
  const seen = n;
  off();
  t.c.input("right");
  assert.equal(n, seen);
  t.c.dispose();
  t.c.input("right");
  t.timers.advance(60 * 60_000);
  assert.equal(t.s().screensaver, false);
});
