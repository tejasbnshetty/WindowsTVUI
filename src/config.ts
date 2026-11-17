// Where config.json lives, and carrying settings over from the pre-rename app-data folder.
import * as fs from "fs";
import * as path from "path";

export interface ConfigLocation {
  /** True when running the installed/portable build (app code is read-only inside app.asar). */
  packaged: boolean;
  /** The config.json shipped with the app (inside app.asar when packaged). */
  bundledConfig: string;
  /** App-data directory (%APPDATA%\Couch UI). */
  userData: string;
}

/**
 * Development: the project's own config.json, edited in place.
 * Packaged: %APPDATA%\Couch UI\config.json, seeded from the bundled default on first run, so the
 * user has an ordinary writable file to edit that also survives reinstalls and updates.
 */
export function prepareConfig(loc: ConfigLocation): string {
  if (!loc.packaged) return loc.bundledConfig;
  const target = path.join(loc.userData, "config.json");
  if (!fs.existsSync(target)) {
    fs.mkdirSync(loc.userData, { recursive: true });
    fs.copyFileSync(loc.bundledConfig, target);
  }
  return target;
}

const CARRIED_OVER = ["devices.json", "settings.json"];

/**
 * M1-M4 stored data under %APPDATA%\windows-tv-ui. The app is now called "Couch UI", so Electron's
 * app-data folder changed; copy the paired-phone list and settings across once so nobody has to re-pair.
 * Never overwrites anything that already exists. Returns the files that were copied.
 */
export function migrateLegacyData(newDir: string, legacyDir: string): string[] {
  const copied: string[] = [];
  if (path.resolve(newDir) === path.resolve(legacyDir)) return copied;
  for (const name of CARRIED_OVER) {
    const from = path.join(legacyDir, name);
    const to = path.join(newDir, name);
    try {
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        fs.mkdirSync(newDir, { recursive: true });
        fs.copyFileSync(from, to);
        copied.push(name);
      }
    } catch { /* best effort */ }
  }
  return copied;
}
