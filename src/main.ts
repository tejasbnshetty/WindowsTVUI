import { app, BrowserWindow, ipcMain, shell } from "electron";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

interface Tile {
  id: string;
  label: string;
  color?: string;
  type: "url" | "exe";
  target: string;
}

const configPath = path.join(__dirname, "..", "config.json");

function loadTiles(): Tile[] {
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  return raw.tiles as Tile[];
}

function createWindow(): void {
  const win = new BrowserWindow({
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

// Renderer only gets labels/colors; it launches by id, never by arbitrary target.
ipcMain.handle("tiles:get", () =>
  loadTiles().map(({ id, label, color }) => ({ id, label, color }))
);

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

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
