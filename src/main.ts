import { app, BrowserWindow, ipcMain, Menu, net, powerMonitor, powerSaveBlocker, protocol as electronProtocol, screen, shell } from "electron";
import { execFile, spawn } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { pathToFileURL } from "url";
import * as QRCode from "qrcode";
import { startRemoteServer, RemoteServer } from "./server";
import { Command, ServerMessage, StateMessage } from "./protocol";
import { Input, VK, createInput, createWin32Backend } from "./input";
import { dispatchInput } from "./dispatch";
import { DeviceStore, createFileDeviceStore } from "./devices";
import { createSettingsStore, SettingsStore } from "./settings";
import { DisplayConfig, DisplayInfo, DisplayManager, createDisplayManager, resolveDisplay } from "./displays";
import { Foreground, createForeground } from "./foreground";
import { CLOSE_REFUSAL_TEXT, checkCloseTarget } from "./appControl";
import { Win32, createWin32, handleToNumber } from "./win32";
import { PowerGuard, createPowerGuard } from "./power";
import { createNetworkMonitor, getLanInfo, NetworkMonitor } from "./network";
import { MDNS_HOST, MdnsAdvertiser, createBonjourFactory, createMdnsAdvertiser } from "./mdns";
import { createLogger } from "./logger";
import { migrateLegacyData, prepareConfig, prepareUserFile } from "./config";
import { createRecovery } from "./recovery";
import { AppDef, installedState, launchApp, loadApps } from "./apps";
import { createIconLookup, loadIconFile } from "./icons";
import { customImageUrl, ensureDir, findCustomImage, listWallpapers, resolveCustom, resolveWallpaper } from "./wallpapers";
import type { AboutInfo, DeviceView, LaunchResult, LauncherInfo, PublicApp } from "./ui/types";

interface Config {
  port?: number;
  /** "auto" (default: the display the launcher started on), "primary", a display id, or part of a display's name. */
  display?: DisplayConfig;
  /** "default" (the system default browser), "chrome" | "edge" | "firefox" | "brave", or the path of a browser .exe. */
  browser?: string;
}

const DEFAULT_PORT = 8787;
const APP_ID = "com.couchui.app";
/** A pairing screen / window stays open for 2 minutes when a phone is added on purpose. */
const PAIRING_WINDOW_MS = 120_000;

// Must happen before the app is ready: lets the page load wallpapers and custom logos from app data (couch://).
electronProtocol.registerSchemesAsPrivileged([
  { scheme: "couch", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

/** Set at startup: the project's config.json in development, %APPDATA%\Couch UI\config.json when installed. */
let configFile = path.join(__dirname, "..", "config.json");

function loadConfig(): Config {
  try {
    // Windows editors (Notepad, PowerShell) often save UTF-8 with a BOM, which JSON.parse rejects.
    return JSON.parse(fs.readFileSync(configFile, "utf8").replace(/^﻿/, "")) as Config;
  } catch (err) {
    console.error(`Could not read ${configFile}: ${(err as Error).message}`);
    return {};
  }
}

function configuredPort(): number {
  const p = loadConfig().port;
  return Number.isInteger(p) && p! > 0 && p! < 65536 ? p! : DEFAULT_PORT;
}

function describeStartError(err: unknown, port: number): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "EADDRINUSE") {
    return `Port ${port} is already in use by another program (or another copy of this launcher). Close it, or change "port" in config.json, then restart. The phone remote is disabled until then.`;
  }
  if (code === "EACCES") {
    return `Windows does not allow listening on port ${port}. Change "port" in config.json and restart. The phone remote is disabled until then.`;
  }
  return `The phone remote could not start: ${(err as Error)?.message ?? String(err)}`;
}

const spawnDetached = (file: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });

/** AppIDs of the installed Microsoft Store apps (cached for a minute), or null if PowerShell could not list them. */
let storeCache: { at: number; ids: Set<string> | null } | null = null;
function listStoreApps(): Promise<Set<string> | null> {
  if (storeCache && Date.now() - storeCache.at < 60_000) return Promise.resolve(storeCache.ids);
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-StartApps | ForEach-Object { $_.AppID }"], { timeout: 12_000, windowsHide: true }, (err, stdout) => {
      const ids = err ? null : new Set(String(stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
      storeCache = { at: Date.now(), ids };
      resolve(ids);
    });
  });
}

function startApp(): void {
  let win: BrowserWindow | null = null;
  let remote: RemoteServer | null = null;
  let remoteError: string | null = null;
  let input: Input | null = null;
  let win32: Win32 | null = null;
  let foreground: Foreground | null = null;
  let manager: DisplayManager | null = null;
  let settings: SettingsStore | null = null;
  let deviceStore: DeviceStore | null = null;
  let power: PowerGuard | null = null;
  let monitor: NetworkMonitor | null = null;
  let mdns: MdnsAdvertiser | null = null;
  let quitting = false;

  // ---------- logging, app-data location, config ----------
  const userData = app.getPath("userData");
  const logger = createLogger({ dir: path.join(userData, "logs") });
  logger.installConsole();
  process.on("uncaughtException", (err) => console.error("uncaughtException:", err));
  process.on("unhandledRejection", (reason) => console.error("unhandledRejection:", reason));

  // A custom --user-data-dir (tests, portable setups) means "keep this run isolated": no carrying data over.
  if (!app.commandLine.hasSwitch("user-data-dir")) {
    const copied = migrateLegacyData(userData, path.join(app.getPath("appData"), "windows-tv-ui"));
    if (copied.length) console.log(`Carried over from the old app-data folder: ${copied.join(", ")}`);
  }
  const bundledDir = path.join(__dirname, "..");
  configFile = prepareConfig({ packaged: app.isPackaged, bundledConfig: path.join(bundledDir, "config.json"), userData });
  const appsFile = prepareUserFile("apps.json", { packaged: app.isPackaged, bundledDir, userData });
  const wallpapersDir = path.join(userData, "wallpapers");
  const customDir = path.join(userData, "assets", "custom");
  ensureDir(wallpapersDir);
  ensureDir(customDir);
  console.log(`Couch UI ${app.getVersion()} starting (${app.isPackaged ? "installed/portable" : "development"}); config: ${configFile}`);

  const icons = createIconLookup(() => loadIconFile(path.join(bundledDir, "build", "simple-icons.json")));

  function alive(): BrowserWindow | null {
    return win && !win.isDestroyed() ? win : null;
  }

  // ---------- apps ----------
  function readApps(): AppDef[] {
    const parsed = loadApps(appsFile);
    for (const p of parsed.problems) console.warn(`apps.json: ${p}`);
    return parsed.apps;
  }

  function toPublic(a: AppDef): PublicApp {
    const custom = findCustomImage(customDir, a.id, a.image);
    return {
      id: a.id,
      name: a.name,
      category: a.category,
      type: a.launch,
      color: a.color,
      iconPath: custom ? null : icons.path(a.icon),
      imageUrl: custom ? customImageUrl(custom) : null,
      installed: installedState(a, { exists: fs.existsSync, env: process.env }),
    };
  }

  async function launchById(id: unknown): Promise<LaunchResult> {
    const def = typeof id === "string" ? readApps().find((a) => a.id === id) : undefined;
    if (!def) return { ok: false, code: "unknown-app", message: "That app is no longer in apps.json" };
    const outcome = await launchApp(def, {
      exists: fs.existsSync,
      env: process.env,
      openExternal: (url) => shell.openExternal(url),
      spawnDetached,
      listStoreApps,
      browser: loadConfig().browser,
    });
    if (!outcome.ok) {
      console.warn(`Launch ${def.id} failed (${outcome.code}): ${outcome.message}`);
      return outcome;
    }
    settings?.setUi({ lastLaunchedId: def.id });
    stepAside();
    // Lets the phone switch itself to Trackpad mode after a browser launch.
    remote?.broadcast({ type: "launched", kind: def.launch === "url" ? "browser" : "app" });
    return { ok: true, lastLaunchedId: def.id };
  }

  // ---------- display helpers ----------
  function listDisplays(): DisplayInfo[] {
    const primaryId = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d) => ({
      id: d.id,
      label: d.label ?? "",
      x: d.bounds.x,
      y: d.bounds.y,
      width: d.bounds.width,
      height: d.bounds.height,
      primary: d.id === primaryId,
    }));
  }

  // ---------- window ----------
  function createWindow(display: DisplayInfo | null): void {
    win = new BrowserWindow({
      ...(display ? { x: display.x, y: display.y, width: display.width, height: display.height } : {}),
      title: "Couch UI",
      icon: path.join(__dirname, "..", "build", "icon.png"),
      fullscreen: true,
      frame: false,
      backgroundColor: "#05070c",
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, "..", "ui-dist", "index.html"));
  }

  let bringing: Promise<{ ok: boolean; method: string }> | null = null;

  /** Brings the launcher to the front with keyboard focus; falls back gracefully if Windows refuses. */
  function bringToFront(): Promise<{ ok: boolean; method: string }> {
    if (bringing) return bringing; // rapid Home taps share one attempt
    bringing = (async () => {
      const w = alive();
      if (!w) return { ok: false, method: "no-window" };
      if (w.isMinimized()) w.restore();
      if (!w.isVisible()) w.show();
      if (!w.isFullScreen()) w.setFullScreen(true);

      let result: { ok: boolean; method: string } = { ok: false, method: "unavailable" };
      if (foreground) {
        try {
          result = await foreground.force(handleToNumber(w.getNativeWindowHandle()));
        } catch (err) {
          console.error("foreground.force failed:", err);
        }
      }
      if (!result.ok && !w.isDestroyed()) {
        // Windows refused. Still make the launcher visible: pulse always-on-top (never left on) and flash the taskbar.
        w.setAlwaysOnTop(true);
        w.show();
        w.focus();
        setTimeout(() => { if (!w.isDestroyed()) w.setAlwaysOnTop(false); }, 600);
        w.flashFrame(true);
        setTimeout(() => { if (!w.isDestroyed()) w.flashFrame(false); }, 1500);
      }
      if (!w.isDestroyed()) w.webContents.focus();
      if (!result.ok) console.warn("Could not take keyboard focus (tried: " + result.method + ")");
      return result;
    })().finally(() => { bringing = null; });
    return bringing;
  }

  /** Get the launcher out of the way so the app that was just launched is visible and gets input. */
  function stepAside(): void {
    const w = alive();
    if (!w) return;
    w.setAlwaysOnTop(false);
    w.minimize();
  }

  function launcherVisible(): boolean {
    const w = alive();
    return !!w && w.isVisible() && !w.isMinimized();
  }

  // ---------- what the launcher panel and the phones are told ----------
  let qrCache: { url: string; dataUrl: string } | null = null;

  async function qrFor(url: string | null): Promise<string | null> {
    if (!url) return null;
    if (qrCache?.url === url) return qrCache.dataUrl;
    try {
      const dataUrl = await QRCode.toDataURL(url, { margin: 2, width: 480, errorCorrectionLevel: "M" });
      qrCache = { url, dataUrl };
      return dataUrl;
    } catch (err) {
      console.error("QR generation failed:", err);
      return null;
    }
  }

  async function buildInfo(): Promise<LauncherInfo> {
    const lan = monitor?.current() ?? getLanInfo();
    const port = remote?.port ?? null;
    const url = lan && port ? `http://${lan.ip}:${port}` : null;
    const m = mdns?.state();
    return {
      error: remoteError,
      url,
      mdnsUrl: m?.running && port ? `http://${MDNS_HOST}:${port}` : null,
      qr: await qrFor(url),
      pairing: remote?.getPairing() ?? { open: false, pin: null, expiresAt: null },
      devices: remote?.deviceCount() ?? 0,
      connected: remote?.connectedCount() ?? 0,
      network: { online: !!lan, label: lan?.label ?? null, ip: lan?.ip ?? null },
    };
  }

  function pushInfo(): void {
    void buildInfo().then((info) => alive()?.webContents.send("remote:info", info)).catch((err) => console.error("pushInfo failed:", err));
  }

  function buildState(): StateMessage {
    const p = remote?.getPairing();
    return {
      type: "state",
      displays: manager?.views() ?? [],
      devices: remote?.deviceCount() ?? 0,
      pairing: { open: p?.open ?? false, expiresAt: p?.expiresAt ?? null },
      displayChoice: settings?.get().display ? "saved" : "default",
    };
  }

  // ---------- remote server (can be re-bound after sleep / network trouble) ----------
  async function startServer(): Promise<void> {
    const port = configuredPort();
    try {
      remote = await startRemoteServer({
        port,
        onCommand: handleCommand,
        deviceStore: deviceStore ?? undefined,
        getState: buildState,
        onPairingChange: () => pushInfo(),
        onConnectionsChange: () => pushInfo(),
        pairingWindowMs: PAIRING_WINDOW_MS,
      });
      remoteError = null;
      console.log(`Remote server listening on port ${remote.port}`);
      mdns?.start(remote.port, monitor?.current()?.ip ?? getLanInfo()?.ip ?? null);
    } catch (err) {
      remote = null;
      remoteError = describeStartError(err, port);
      console.error(remoteError);
    }
  }

  async function restartServer(): Promise<void> {
    const old = remote;
    remote = null;
    if (old) await old.close().catch((err) => console.error("closing the old server failed:", err));
    await startServer();
  }

  function probeServer(): Promise<boolean> {
    const port = remote?.port;
    if (!port) return Promise.resolve(false);
    return new Promise((resolve) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/api/session", timeout: 1500, agent: false }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on("timeout", () => { req.destroy(); resolve(false); });
      req.on("error", () => resolve(false));
    });
  }

  // ---------- commands from the phone ----------
  function handleCommand(cmd: Command, reply: (msg: ServerMessage) => void): void {
    switch (cmd.type) {
      case "nav": {
        if (!alive()) return;
        if (cmd.action === "home" || cmd.action === "back") {
          void bringToFront().then((r) => {
            if (!r.ok) reply({ type: "notice", text: "Launcher is showing, but Windows refused to give it keyboard focus. Phone navigation still works." });
          });
        } else if (!launcherVisible()) {
          // Launcher is hidden behind a launched app: D-pad/OK must not act on it (OK would
          // re-launch the focused tile). Use Trackpad/Keyboard modes to drive the app instead.
          return;
        }
        alive()?.webContents.send("remote:nav", cmd.action);
        return;
      }
      case "app": {
        if (!input) { reply({ type: "notice", text: "Keyboard control is unavailable." }); return; }
        if (cmd.action === "switch") {
          input.keyTap(VK.TAB, ["alt"]); // quick Alt+Tab = previous app
          return;
        }
        if (!win32) { reply({ type: "notice", text: "Can't check which app is in front, so nothing was closed." }); return; }
        const check = checkCloseTarget(win32, process.pid);
        if (!check.ok) { reply({ type: "notice", text: CLOSE_REFUSAL_TEXT[check.reason] }); return; }
        input.keyTap(VK.F4, ["alt"]);
        return;
      }
      case "display_set": {
        if (!manager || !manager.choose(cmd.id)) reply({ type: "notice", text: "That display is no longer connected." });
        remote?.broadcastState();
        return;
      }
      case "pair_new": {
        remote?.openPairing(); // shows a fresh PIN on the TV; onPairingChange updates the launcher
        reply({ type: "notice", text: "The PIN is now showing on the TV." });
        return;
      }
      case "forget_devices": {
        remote?.forgetAllDevices();
        return;
      }
      case "exit_app": {
        console.log("Exit requested from the phone");
        reply({ type: "notice", text: "Exiting the launcher…" });
        // Give the notice a moment to reach the phone, then quit through the normal clean-shutdown path.
        setTimeout(() => app.quit(), 250);
        return;
      }
      default:
        if (!input) return; // input injection unavailable (non-Windows or koffi failed to load)
        try {
          dispatchInput(cmd, input);
        } catch (err) {
          console.error("Input injection failed:", err);
        }
    }
  }

  // ---------- IPC (launcher UI). Everything from the renderer is validated here. ----------
  ipcMain.handle("apps:list", (): PublicApp[] => readApps().map(toPublic));
  ipcMain.handle("apps:launch", (_e, id: unknown) => launchById(id));
  ipcMain.handle("ui:get", () => settings?.get().ui);
  ipcMain.handle("ui:set", (_e, patch: unknown) => settings?.setUi(patch));
  ipcMain.handle("wallpapers:list", () => listWallpapers(wallpapersDir));
  ipcMain.handle("remote:info", () => buildInfo());
  ipcMain.handle("devices:list", (): DeviceView[] =>
    (deviceStore?.list() ?? []).map((d) => ({ label: d.label, createdAt: d.createdAt })).sort((a, b) => a.createdAt - b.createdAt));
  ipcMain.handle("devices:forget", () => { remote?.forgetAllDevices(); });
  ipcMain.on("pairing:open", () => { remote?.openPairing(); });
  ipcMain.on("pairing:close", () => { remote?.closePairing(); });
  ipcMain.handle("display:list", () => manager?.views() ?? []);
  ipcMain.handle("display:choose", (_e, id: unknown) => {
    if (id !== null && !(typeof id === "number" && Number.isSafeInteger(id))) return false;
    const ok = manager?.choose(id as number | null) ?? false;
    remote?.broadcastState();
    return ok;
  });
  ipcMain.handle("about:get", (): AboutInfo => ({
    version: app.getVersion(), packaged: app.isPackaged, dataDir: userData, configFile, appsFile, wallpapersDir,
  }));
  ipcMain.on("folder:open", (_e, which: unknown) => {
    // Only two fixed folders can be opened; the renderer never supplies a path.
    if (which === "wallpapers") void shell.openPath(wallpapersDir);
    else if (which === "data") void shell.openPath(userData);
  });
  ipcMain.on("app:quit", () => app.quit());

  // ---------- lifecycle ----------
  app.on("second-instance", () => {
    // A second launch just brings the existing launcher forward (and exits).
    void bringToFront();
  });

  async function init(): Promise<void> {
    Menu.setApplicationMenu(null); // no menu: Alt/Ctrl+W from the phone must never act on the launcher itself
    app.setAppUserModelId(APP_ID);

    // couch://wallpaper/<file> and couch://asset/<file>: only plain image file names inside the two app-data folders.
    electronProtocol.handle("couch", (req) => {
      const url = new URL(req.url);
      const file = url.hostname === "wallpaper" ? resolveWallpaper(wallpapersDir, url.pathname.slice(1))
        : url.hostname === "asset" ? resolveCustom(customDir, url.pathname.slice(1))
        : null;
      if (!file || !fs.existsSync(file)) return new Response("Not found", { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    });

    settings = createSettingsStore(path.join(userData, "settings.json"));
    deviceStore = createFileDeviceStore(path.join(userData, "devices.json"));

    power = createPowerGuard({
      start: (t) => powerSaveBlocker.start(t),
      stop: (id) => powerSaveBlocker.stop(id),
      isStarted: (id) => powerSaveBlocker.isStarted(id),
    });
    power.start();

    try {
      input = createInput(createWin32Backend());
    } catch (err) {
      console.error("Mouse/keyboard control unavailable:", err);
    }
    try {
      win32 = createWin32();
      foreground = createForeground({
        api: win32,
        altTap: () => input?.keyTap(VK.MENU),
        log: (m) => console.warn(m),
      });
    } catch (err) {
      console.error("Foreground/app control unavailable:", err);
    }

    const config = loadConfig();
    const startedOnId = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id;
    const first = resolveDisplay(listDisplays(), { saved: settings.get().display, config: config.display, startedOnId });

    // Network watching + mDNS + recovery. Everything here lives and dies with this process.
    mdns = createMdnsAdvertiser({ factory: createBonjourFactory(), log: (m) => console.log(m) });
    const recovery = createRecovery({
      readNetwork: () => getLanInfo(),
      probeServer,
      restartServer,
      updateMdns: (ip) => mdns?.update(ip),
      refreshDisplays: () => manager?.apply(),
      publish: () => { pushInfo(); remote?.broadcastState(); },
      log: (m) => console.log(m),
    });
    monitor = createNetworkMonitor({ read: getLanInfo, onChange: () => { void recovery.onNetworkChange(); } });

    await startServer();
    monitor.start();
    powerMonitor.on("resume", () => { void recovery.onResume(); });

    createWindow(first?.display ?? null);

    manager = createDisplayManager({
      listDisplays,
      subscribe(cb) {
        screen.on("display-added", cb);
        screen.on("display-removed", cb);
        screen.on("display-metrics-changed", cb);
        return () => {
          screen.off("display-added", cb);
          screen.off("display-removed", cb);
          screen.off("display-metrics-changed", cb);
        };
      },
      getWindow: () => alive(),
      getSaved: () => settings?.get().display ?? null,
      setSaved: (d) => settings?.setDisplay(d),
      config: config.display,
      startedOnId,
      onChange: () => remote?.broadcastState(),
    });
    // Safety net: if the window did not open on the intended display, move it.
    alive()?.webContents.once("did-finish-load", () => manager?.apply());
  }

  /** Stop everything cleanly: nothing may be left listening, advertising or holding the screen awake. */
  async function shutdown(): Promise<void> {
    console.log("Shutting down");
    power?.stop();
    monitor?.stop();
    manager?.dispose();
    const tasks: Promise<unknown>[] = [];
    if (mdns) tasks.push(mdns.stop());
    if (remote) {
      const r = remote;
      remote = null;
      tasks.push(r.close());
    }
    await Promise.race([Promise.allSettled(tasks), new Promise<void>((resolve) => setTimeout(resolve, 2500))]);
    console.log("Shutdown complete");
  }

  app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    shutdown().catch((err) => console.error("shutdown error:", err)).finally(() => app.quit());
  });
  app.on("window-all-closed", () => app.quit());
  void app.whenReady().then(init);
}

// Only one launcher at a time: a second launch focuses the first and exits.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  startApp();
}
