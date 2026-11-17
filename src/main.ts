import { app, BrowserWindow, ipcMain, shell } from "electron";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as QRCode from "qrcode";
import { startRemoteServer, RemoteServer, NavAction } from "./server";

interface Tile {
  id: string;
  label: string;
  color?: string;
  type: "url" | "exe";
  target: string;
}

interface Config {
  port?: number;
  tiles: Tile[];
}

const DEFAULT_PORT = 8787;
const configPath = path.join(__dirname, "..", "config.json");

function loadConfig(): Config {
  return JSON.parse(fs.readFileSync(configPath, "utf8")) as Config;
}

function loadTiles(): Tile[] {
  return loadConfig().tiles;
}

function configuredPort(): number {
  const p = loadConfig().port;
  return Number.isInteger(p) && p! > 0 && p! < 65536 ? p! : DEFAULT_PORT;
}

let win: BrowserWindow | null = null;
let remote: RemoteServer | null = null;
let remoteError: string | null = null;

function createWindow(): void {
  win = new BrowserWindow({
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

/** Bring the launcher above whatever app was launched from it. */
function bringToFront(): void {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.setAlwaysOnTop(true); // toggle trick so Windows lets us take the foreground
  win.show();
  win.focus();
  win.setAlwaysOnTop(false);
  if (!win.isFullScreen()) win.setFullScreen(true);
}

function handleNav(action: NavAction): void {
  if (!win || win.isDestroyed()) return;
  if (action === "home" || action === "back") bringToFront();
  win.webContents.send("remote:nav", action);
}

// Renderer only gets labels/colors; it launches by id, never by arbitrary target.
ipcMain.handle("tiles:get", () =>
  loadTiles().map(({ id, label, color }) => ({ id, label, color }))
);

ipcMain.handle("remote:info", async () => {
  if (!remote) return { error: remoteError ?? "Remote server not running" };
  let qr: string | null = null;
  if (remote.url) {
    qr = await QRCode.toDataURL(remote.url, { margin: 2, width: 320, errorCorrectionLevel: "M" });
  }
  return { url: remote.url, pin: remote.pin, qr };
});

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
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.on("app:quit", () => app.quit());

app.whenReady().then(async () => {
  try {
    remote = await startRemoteServer({ port: configuredPort(), onNav: handleNav });
    console.log(`Remote server listening: ${remote.url ?? "(no LAN address found)"}`);
  } catch (err) {
    remoteError = `Remote unavailable: ${(err as Error).message}`;
    console.error(remoteError);
  }
  createWindow();
});

app.on("will-quit", () => remote?.close());
app.on("window-all-closed", () => app.quit());
