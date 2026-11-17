// Small user settings that the remote / launcher can change (kept out of config.json, which the user edits by hand).
import * as fs from "fs";
import * as path from "path";
import type { UiSettings } from "./ui/types";
import { DEFAULT_UI, mergeUi, sanitizeUi } from "./uiSettings";

export interface SavedDisplay {
  id: number;
  label: string;
  width: number;
  height: number;
}

export interface Settings {
  /** Display chosen from the remote's Settings tab; null = use the default. */
  display: SavedDisplay | null;
  /** Launcher preferences: wallpaper, screensaver, effects, last launched app. */
  ui: UiSettings;
}

export interface SettingsStore {
  get(): Settings;
  setDisplay(d: SavedDisplay | null): void;
  /** Merges a (validated) partial update and saves. Returns the new settings. */
  setUi(patch: unknown): UiSettings;
}

function isSavedDisplay(v: unknown): v is SavedDisplay {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return Number.isSafeInteger(d.id) && typeof d.label === "string"
    && typeof d.width === "number" && typeof d.height === "number";
}

export function createSettingsStore(file: string): SettingsStore {
  let settings: Settings = { display: null, ui: DEFAULT_UI };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
    settings = {
      display: isSavedDisplay(parsed?.display) ? parsed.display : null,
      ui: sanitizeUi(parsed?.ui),
    };
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
    setUi(patch) {
      settings = { ...settings, ui: mergeUi(settings.ui, patch) };
      save();
      return settings.ui;
    },
  };
}
