// The launcher's brain: owns all UI state and behaviour, with no DOM and no framework. Preact only renders
// getState(). Because the main-process bridge (`tv`) and the timers are injected, every flow in here (focus
// movement, settings, screensaver wake, pairing screens, launching) is unit-tested with mocks.
import { ROTATE_OPTIONS, SCREENSAVER_OPTIONS, mergeUi } from "../uiSettings";
import { createIdleTimer, type IdleDeps, type IdleTimer } from "./idle";
import { clampFocus, firstFocus, moveFocus, type Dir, type Focus } from "./nav";
import { buildRows, rowCounts, type Row } from "./rows";
import { derivePairing, type PairingUi } from "./screens";
import { buildSections, nextChoice, type Section, type SettingsData } from "./settingsModel";
import { clampSettingsFocus, stepSettings, type SettingsFocus } from "./settingsNav";
import { activeWallpaper, nextIndex, seededRandom, slideshowOrder, wallpaperOptions, type WallpaperOption } from "./slides";
import type { AboutInfo, DeviceView, DisplayView, LauncherInfo, PublicApp, TvApi, UiSettings } from "./types";

export type Action = "up" | "down" | "left" | "right" | "ok" | "back" | "home";
const ACTIONS: ReadonlySet<string> = new Set(["up", "down", "left", "right", "ok", "back", "home"]);
export const isAction = (a: string): a is Action => ACTIONS.has(a);

export interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
}

export interface UiState {
  ready: boolean;
  apps: PublicApp[];
  rows: Row[];
  info: LauncherInfo | null;
  ui: UiSettings;
  wallpapers: WallpaperOption[];
  focus: Focus;
  memory: number;
  screen: "home" | "settings";
  settingsFocus: SettingsFocus;
  displays: DisplayView[];
  devices: DeviceView[];
  about: AboutInfo | null;
  /** Action id waiting for its second press (two-step confirm). */
  armed: string | null;
  screensaver: boolean;
  slideshow: WallpaperOption[];
  rotateIndex: number;
  toast: Toast | null;
  visible: boolean;
}

export interface ControllerEnv {
  tv: TvApi;
  timers?: IdleDeps;
  now?: () => number;
  random?: () => number;
}

const TOAST_MS = 4500;
const ARM_MS = 4000;

const DEFAULT_UI: UiSettings = {
  wallpaper: { mode: "single", id: "builtin:aurora", minutes: 10 },
  screensaverMinutes: 5,
  reduceEffects: false,
  lastLaunchedId: null,
};

export interface Controller {
  getState(): UiState;
  subscribe(fn: () => void): () => void;
  init(): Promise<void>;
  /** Navigation / OK / back / home, from the laptop keyboard or the phone remote. */
  input(action: Action): void;
  /** Mouse or other non-navigation activity: wakes the screensaver, restarts the idle timer. Never triggers an action. */
  activity(): void;
  /** A click on a home tile. */
  clickTile(row: number, col: number): void;
  /** The "P" key. */
  pairKey(): void;
  /** The Esc key. */
  exitKey(): void;
  setVisible(visible: boolean): void;
  previewScreensaver(): void;
  sections(): Section[];
  pairing(): PairingUi;
  dispose(): void;
}

export function createController(env: ControllerEnv): Controller {
  const { tv } = env;
  const timers: IdleDeps = env.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  const now = env.now ?? Date.now;
  const random = env.random ?? seededRandom(now());

  let state: UiState = {
    ready: false, apps: [], rows: buildRows([]), info: null, ui: DEFAULT_UI, wallpapers: wallpaperOptions([]),
    focus: { zone: "hero" }, memory: 0, screen: "home", settingsFocus: { zone: "menu", section: 0 },
    displays: [], devices: [], about: null, armed: null, screensaver: false, slideshow: [], rotateIndex: 0,
    toast: null, visible: true,
  };
  const subs = new Set<() => void>();
  let toastSeq = 0;
  let toastTimer: unknown = null;
  let armTimer: unknown = null;
  let rotateTimer: unknown = null;
  let launching = false;
  let disposed = false;
  let lastConnected = 0;

  function set(patch: Partial<UiState>): void {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const fn of [...subs]) fn();
  }

  const idle: IdleTimer = createIdleTimer({
    getMinutes: () => state.ui.screensaverMinutes,
    onIdle: () => startScreensaver(),
    deps: timers,
  });

  // ---------- derived ----------
  const sections = (): Section[] => buildSections(settingsData());
  const settingsData = (): SettingsData => ({
    displays: state.displays, devices: state.devices, wallpapers: state.wallpapers, about: state.about, ui: state.ui, armed: state.armed,
  });
  const pairing = (): PairingUi => derivePairing(state.info);

  // ---------- toast / arming ----------
  function toast(text: string, kind: Toast["kind"] = "info"): void {
    if (toastTimer !== null) timers.clearTimeout(toastTimer);
    const id = ++toastSeq;
    set({ toast: { id, text, kind } });
    toastTimer = timers.setTimeout(() => { toastTimer = null; if (state.toast?.id === id) set({ toast: null }); }, TOAST_MS);
  }

  function arm(id: string): void {
    if (armTimer !== null) timers.clearTimeout(armTimer);
    set({ armed: id });
    armTimer = timers.setTimeout(() => { armTimer = null; set({ armed: null }); }, ARM_MS);
  }

  function disarm(): void {
    if (armTimer !== null) { timers.clearTimeout(armTimer); armTimer = null; }
    if (state.armed !== null) set({ armed: null });
  }

  // ---------- screensaver ----------
  function startScreensaver(): void {
    if (disposed || !state.visible || state.screensaver) return;
    // Not while a pairing screen is up: the person is reading a PIN.
    if (pairing().screen.kind !== "home") { idle.activity(); return; }
    set({ screensaver: true, slideshow: slideshowOrder(state.wallpapers, random) });
  }

  function wake(): void {
    if (state.screensaver) set({ screensaver: false });
    idle.activity();
  }

  // ---------- wallpaper rotation ----------
  function resetRotation(): void {
    if (rotateTimer !== null) { timers.clearTimeout(rotateTimer); rotateTimer = null; }
    const w = state.ui.wallpaper;
    if (w.mode !== "rotate" || state.wallpapers.length < 2) return;
    rotateTimer = timers.setTimeout(() => {
      rotateTimer = null;
      set({ rotateIndex: nextIndex(state.rotateIndex, state.wallpapers.length) });
      resetRotation();
    }, w.minutes * 60_000);
  }

  // ---------- data ----------
  async function loadSettingsData(): Promise<void> {
    const [displays, devices, about] = await Promise.all([
      tv.getDisplays().catch(() => [] as DisplayView[]),
      tv.getDevices().catch(() => [] as DeviceView[]),
      state.about ? Promise.resolve(state.about) : tv.getAbout().catch(() => null),
    ]);
    set({ displays, devices, about });
  }

  /**
   * Applies the change to the local state IMMEDIATELY (so quick repeated key presses compound instead of all
   * reading the same stale value while the IPC round trip is in flight), then persists it and adopts the
   * authoritative value the main process returns.
   */
  async function saveUi(patch: Partial<UiSettings> | { wallpaper: Partial<UiSettings["wallpaper"]> }): Promise<void> {
    set({ ui: mergeUi(state.ui, patch) });
    idle.refresh();
    resetRotation();
    try {
      const ui = await tv.setUi(patch as Partial<UiSettings>);
      set({ ui: { ...ui, lastLaunchedId: state.ui.lastLaunchedId ?? ui.lastLaunchedId } });
      idle.refresh();
      resetRotation();
    } catch {
      toast("Could not save that setting", "error");
    }
  }

  // ---------- launching ----------
  async function launch(app: PublicApp): Promise<void> {
    if (launching) return;
    launching = true;
    try {
      const res = await tv.launch(app.id);
      if (res.ok) {
        set({ ui: { ...state.ui, lastLaunchedId: res.lastLaunchedId } });
      } else {
        toast(res.message, "error");
      }
    } catch {
      toast(`Could not open ${app.name}`, "error");
    } finally {
      launching = false;
    }
  }

  const lastLaunchedApp = (): PublicApp | undefined => state.apps.find((a) => a.id === state.ui.lastLaunchedId);

  function activateFocus(): void {
    const f = state.focus;
    if (f.zone === "hero") {
      const app = lastLaunchedApp();
      if (app) void launch(app);
      else set({ focus: firstFocus(rowCounts(state.rows)) }); // welcome banner: "Browse apps"
      return;
    }
    const item = state.rows[f.row]?.items[f.col];
    if (!item) return;
    if (item.kind === "settings") openSettings();
    else void launch(item.app);
  }

  // ---------- settings screen ----------
  function openSettings(): void {
    set({ screen: "settings", settingsFocus: { zone: "menu", section: 0 }, armed: null });
    void loadSettingsData();
  }

  function closeSettings(): void {
    disarm();
    set({ screen: "home" });
  }

  function adjust(itemId: string, dir: -1 | 1): void {
    const ui = state.ui;
    switch (itemId) {
      case "reduce-fx": void saveUi({ reduceEffects: !ui.reduceEffects }); break;
      case "wp-mode": void saveUi({ wallpaper: { mode: ui.wallpaper.mode === "rotate" ? "single" : "rotate" } }); break;
      case "wp-minutes": void saveUi({ wallpaper: { minutes: nextChoice(ROTATE_OPTIONS, ui.wallpaper.minutes as (typeof ROTATE_OPTIONS)[number], dir) } }); break;
      case "wp-pick": {
        const opts = state.wallpapers;
        if (opts.length === 0) break;
        const i = Math.max(0, opts.findIndex((o) => o.id === ui.wallpaper.id));
        void saveUi({ wallpaper: { id: opts[(i + dir + opts.length) % opts.length].id } });
        break;
      }
      case "ss-minutes": void saveUi({ screensaverMinutes: nextChoice(SCREENSAVER_OPTIONS, ui.screensaverMinutes as (typeof SCREENSAVER_OPTIONS)[number], dir) }); break;
    }
  }

  async function chooseDisplay(id: number | null): Promise<void> {
    const ok = await tv.chooseDisplay(id).catch(() => false);
    if (!ok) toast("That display isn't connected any more", "error");
    await loadSettingsData();
  }

  function activate(itemId: string): void {
    if (itemId !== state.armed) disarm();
    if (itemId.startsWith("display:")) { void chooseDisplay(Number(itemId.slice("display:".length))); return; }
    switch (itemId) {
      case "display-reset": void chooseDisplay(null); break;
      case "wp-folder": tv.openFolder("wallpapers"); break;
      case "ss-preview": closeSettings(); startScreensaver(); break;
      case "dev-pair": tv.openPairing(); break;
      case "open-data": tv.openFolder("data"); break;
      case "dev-forget":
        if (state.armed === "dev-forget") {
          disarm();
          void tv.forgetDevices().then(() => { toast("All phones forgotten"); return loadSettingsData(); });
        } else arm("dev-forget");
        break;
      case "exit":
        if (state.armed === "exit") { disarm(); tv.quit(); } else arm("exit");
        break;
    }
  }

  function settingsInput(action: Action): void {
    if (action === "home") { closeSettings(); set({ focus: firstFocus(rowCounts(state.rows)) }); return; }
    const secs = sections();
    const focus = clampSettingsFocus(secs, state.settingsFocus);
    const step = stepSettings(secs, focus, action);
    const item = step.focus.zone === "pane" ? secs[step.focus.section]?.items[step.focus.item] : undefined;
    // Moving away from an armed action cancels the confirmation.
    if (state.armed && !(step.effect?.type === "activate" && item?.id === state.armed)) disarm();
    set({ settingsFocus: step.focus });
    const e = step.effect;
    if (!e) return;
    if (e.type === "close") closeSettings();
    else if (e.type === "adjust") adjust(secs[e.section].items[e.item].id, e.dir);
    else activate(secs[e.section].items[e.item].id);
  }

  // ---------- public input ----------
  function homeInput(action: Action): void {
    const counts = rowCounts(state.rows);
    switch (action) {
      case "up": case "down": case "left": case "right": {
        const m = moveFocus(counts, state.focus, action as Dir, state.memory);
        set({ focus: m.focus, memory: m.memory });
        break;
      }
      case "ok": activateFocus(); break;
      case "back": case "home": set({ focus: firstFocus(counts), memory: 0 }); break;
    }
  }

  function input(action: Action): void {
    if (disposed) return;
    idle.activity();
    // The first input after the screensaver only wakes it: it must never trigger an action.
    if (state.screensaver) { wake(); return; }

    const p = pairing().screen;
    if (p.kind === "connect") return; // waiting for the first phone; Esc exits
    if (p.kind === "pair-new") {
      if (action === "back" || action === "home") tv.closePairing(); // cancel
      return;
    }
    if (state.screen === "settings") settingsInput(action);
    else homeInput(action);
  }

  async function init(): Promise<void> {
    tv.onInfo((info) => {
      const prev = state.info;
      set({ info });
      if (prev && prev.connected === 0 && info.connected > 0) toast("Phone connected");
      lastConnected = info.connected;
    });
    tv.onNav((a) => { if (isAction(a)) input(a); });

    const [apps, ui, files, info] = await Promise.all([
      tv.getApps().catch(() => [] as PublicApp[]),
      tv.getUi().catch(() => DEFAULT_UI),
      tv.getWallpapers().catch(() => []),
      tv.getRemoteInfo().catch(() => null),
    ]);
    const rows = buildRows(apps);
    set({
      ready: true, apps, rows, ui, wallpapers: wallpaperOptions(files), info,
      focus: clampFocus(rowCounts(rows), firstFocus(rowCounts(rows))),
    });
    lastConnected = info?.connected ?? 0;
    idle.activity();
    resetRotation();
  }

  return {
    getState: () => state,
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
    init,
    input,
    activity() { if (disposed) return; if (state.screensaver) wake(); else idle.activity(); },
    clickTile(row, col) {
      if (disposed) return;
      idle.activity();
      if (state.screensaver) { wake(); return; }
      if (pairing().screen.kind !== "home" || state.screen !== "home") return;
      set({ focus: { zone: "row", row, col }, memory: col });
      activateFocus();
    },
    pairKey() {
      idle.activity();
      if (state.screensaver) { wake(); return; }
      tv.openPairing();
    },
    exitKey() {
      idle.activity();
      if (state.screensaver) { wake(); return; }
      tv.quit();
    },
    setVisible(visible) {
      set({ visible });
      idle.setVisible(visible);
      if (!visible && state.screensaver) set({ screensaver: false }); // a hidden launcher must not come back mid-screensaver
    },
    previewScreensaver() { startScreensaver(); },
    sections,
    pairing,
    dispose() {
      disposed = true;
      idle.stop();
      for (const h of [toastTimer, armTimer, rotateTimer]) if (h !== null) timers.clearTimeout(h);
      subs.clear();
    },
  };
}

// Re-exports used by components and tests.
export { activeWallpaper };
export type { WallpaperOption };
