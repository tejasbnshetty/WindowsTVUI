import { app, BrowserWindow, ipcMain, Menu, powerSaveBlocker, screen, shell } from "electron";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as QRCode from "qrcode";
import { startRemoteServer, RemoteServer, PairingState } from "./server";
import { Command, ServerMessage, StateMessage } from "./protocol";
import { Input, VK, createInput, createWin32Backend } from "./input";
import { dispatchInput } from "./dispatch";
import { createFileDeviceStore } from "./devices";
import { createSettingsStore, SettingsStore } from "./settings";
import { DisplayConfig, DisplayInfo, DisplayManager, createDisplayManager, resolveDisplay } from "./displays";
import { Foreground, createForeground } from "./foreground";
import { CLOSE_REFUSAL_TEXT, checkCloseTarget } from "./appControl";
import { Win32, createWin32, handleToNumber } from "./win32";
import { PowerGuard, createPowerGuard } from "./power";

interface Tile {
  id: string;
  label: string;
  color?: string;
  type: "url" | "exe";
  target: string;
}

interface Config {
  port?: number;
  /** "auto" (default: the display the launcher started on), "primary", a display id, or part of a display's name. */
  display?: DisplayConfig;
  tiles: Tile[];
}

const DEFAULT_PORT = 8787;
const configPath = path.join(__dirname, "..", "config.json");

function loadConfig(): Config {
  // Windows editors (Notepad, PowerShell) often save UTF-8 with a BOM, which JSON.parse rejects.
  return JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^﻿/, "")) as Config;
}

function loadTiles(): Tile[] {
  return loadConfig().tiles;
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

function startApp(): void {
  let win: BrowserWindow | null = null;
  let remote: RemoteServer | null = null;
  let remoteError: string | null = null;
  let input: Input | null = null;
  let win32: Win32 | null = null;
  let foreground: Foreground | null = null;
  let manager: DisplayManager | null = null;
  let settings: SettingsStore | null = null;
  let power: PowerGuard | null = null;
  let qrDataUrl: string | null = null;
  let quitting = false;

  function alive(): BrowserWindow | null {
    return win && !win.isDestroyed() ? win : null;
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
      fullscreen: true,
      frame: false,
      backgroundColor: "#0b0d12",
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, "..", "static", "index.html"));
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

  // ---------- remote state ----------
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

  function pushPairingToLauncher(p: PairingState): void {
    alive()?.webContents.send("remote:pairing", p, remote?.deviceCount() ?? 0);
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
      default:
        if (!input) return; // input injection unavailable (non-Windows or koffi failed to load)
        try {
          dispatchInput(cmd, input);
        } catch (err) {
          console.error("Input injection failed:", err);
        }
    }
  }

  // ---------- IPC (launcher renderer) ----------
  // Renderer only gets labels/colors; it launches by id, never by arbitrary target.
  ipcMain.handle("tiles:get", () => loadTiles().map(({ id, label, color }) => ({ id, label, color })));

  ipcMain.handle("remote:info", () => ({
    error: remoteError,
    url: remote?.url ?? null,
    qr: qrDataUrl,
    pairing: remote?.getPairing() ?? { open: false, pin: null, expiresAt: null },
    devices: remote?.deviceCount() ?? 0,
  }));

  ipcMain.on("pairing:open", () => { remote?.openPairing(); });

  ipcMain.handle("tiles:launch", async (_e, id: string) => {
    const tile = loadTiles().find((t) => t.id === id);
    if (!tile) return { ok: false, error: "Unknown tile" };
    try {
      if (tile.type === "url") {
        if (!/^https?:\/\//i.test(tile.target)) return { ok: false, error: "Only http(s) URLs allowed" };
        await shell.openExternal(tile.target);
      } else {
        if (!fs.existsSync(tile.target)) return { ok: false, error: `Not found: ${tile.target}` };
        const child = spawn(tile.target, [], { detached: true, stdio: "ignore" });
        child.on("error", () => {});
        child.unref();
      }
      stepAside();
      // Lets the phone switch itself to Trackpad mode after a browser launch.
      remote?.broadcast({ type: "launched", kind: tile.type === "url" ? "browser" : "app" });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.on("app:quit", () => app.quit());

  // ---------- lifecycle ----------
  app.on("second-instance", () => {
    // A second launch just brings the existing launcher forward (and exits).
    void bringToFront();
  });

  async function init(): Promise<void> {
    Menu.setApplicationMenu(null); // no menu: Alt/Ctrl+W from the phone must never act on the launcher itself

    const userData = app.getPath("userData");
    settings = createSettingsStore(path.join(userData, "settings.json"));

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

    const port = configuredPort();
    try {
      remote = await startRemoteServer({
        port,
        onCommand: handleCommand,
        deviceStore: createFileDeviceStore(path.join(userData, "devices.json")),
        getState: buildState,
        onPairingChange: pushPairingToLauncher,
      });
      console.log(`Remote server listening: ${remote.url ?? "(no LAN address found)"}`);
      if (remote.url) qrDataUrl = await QRCode.toDataURL(remote.url, { margin: 2, width: 320, errorCorrectionLevel: "M" });
    } catch (err) {
      remoteError = describeStartError(err, port);
      console.error(remoteError);
    }

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

  /** Stop everything cleanly and free the port before the process exits. */
  async function shutdown(): Promise<void> {
    power?.stop();
    manager?.dispose();
    if (remote) {
      const r = remote;
      remote = null;
      await Promise.race([r.close(), new Promise<void>((resolve) => setTimeout(resolve, 2000))]);
    }
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
