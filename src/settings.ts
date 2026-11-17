// Small user settings that the remote can change (kept out of config.json, which the user edits by hand).
import * as fs from "fs";
import * as path from "path";

export interface SavedDisplay {
  id: number;
  label: string;
  width: number;
  height: number;
}

export interface Settings {
  /** Display chosen from the remote's Settings tab; null = use the default. */
  display: SavedDisplay | null;
}

export interface SettingsStore {
  get(): Settings;
  setDisplay(d: SavedDisplay | null): void;
}

function isSavedDisplay(v: unknown): v is SavedDisplay {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return Number.isSafeInteger(d.id) && typeof d.label === "string"
    && typeof d.width === "number" && typeof d.height === "number";
}

export function createSettingsStore(file: string): SettingsStore {
  let settings: Settings = { display: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
    if (isSavedDisplay(parsed?.display)) settings = { display: parsed.display };
  } catch {
    /* missing or unreadable: defaults */
  }

  function save(): void {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf8");
      fs.renameSync(tmp, file);
    } catch (err) {
      console.error("Could not save settings:", err);
    }
  }

  return {
    get: () => settings,
    setDisplay(d) {
      settings = { ...settings, display: d };
      save();
    },
  };
}
