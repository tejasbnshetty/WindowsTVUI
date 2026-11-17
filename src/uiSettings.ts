// Launcher UI preferences (wallpaper, screensaver, effects, last launched app).
// Shared by main (validates what the renderer sends) and the UI (option lists).
import type { UiSettings } from "./ui/types";

export const SCREENSAVER_OPTIONS = [0, 1, 2, 5, 10, 15, 30] as const;
export const ROTATE_OPTIONS = [1, 2, 5, 10, 15, 30] as const;

export const BUILTIN_WALLPAPER_IDS = ["aurora", "ember", "ocean", "midnight"] as const;
export const DEFAULT_WALLPAPER_ID = "builtin:aurora";

export const DEFAULT_UI: UiSettings = {
  wallpaper: { mode: "single", id: DEFAULT_WALLPAPER_ID, minutes: 10 },
  screensaverMinutes: 5,
  reduceEffects: false,
  lastLaunchedId: null,
};

const WALLPAPER_ID = /^(builtin:[a-z0-9-]{1,40}|file:[^\\/:*?"<>|\u0000-\u001f]{1,200})$/;
const APP_ID = /^[a-z0-9][a-z0-9_-]{0,40}$/;

function nearest(value: unknown, allowed: readonly number[], fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return allowed.reduce((best, n) => (Math.abs(n - value) < Math.abs(best - value) ? n : best), allowed[0]);
}

/** Validates untrusted input (a file on disk, or the renderer): unknown keys dropped, values clamped to allowed choices. */
export function sanitizeUi(v: unknown, base: UiSettings = DEFAULT_UI): UiSettings {
  const o = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  const w = (typeof o.wallpaper === "object" && o.wallpaper !== null ? o.wallpaper : {}) as Record<string, unknown>;
  return {
    wallpaper: {
      mode: w.mode === "rotate" ? "rotate" : w.mode === "single" ? "single" : base.wallpaper.mode,
      id: typeof w.id === "string" && WALLPAPER_ID.test(w.id) ? w.id : base.wallpaper.id,
      minutes: nearest(w.minutes, ROTATE_OPTIONS, base.wallpaper.minutes),
    },
    screensaverMinutes: "screensaverMinutes" in o ? nearest(o.screensaverMinutes, SCREENSAVER_OPTIONS, base.screensaverMinutes) : base.screensaverMinutes,
    reduceEffects: typeof o.reduceEffects === "boolean" ? o.reduceEffects : base.reduceEffects,
    lastLaunchedId: "lastLaunchedId" in o
      ? (o.lastLaunchedId === null ? null : typeof o.lastLaunchedId === "string" && APP_ID.test(o.lastLaunchedId) ? o.lastLaunchedId : base.lastLaunchedId)
      : base.lastLaunchedId,
  };
}

/** Merge a partial update from the renderer into the current settings (deeply for wallpaper). */
export function mergeUi(current: UiSettings, patch: unknown): UiSettings {
  const p = (typeof patch === "object" && patch !== null ? patch : {}) as Record<string, unknown>;
  const wp = (typeof p.wallpaper === "object" && p.wallpaper !== null ? p.wallpaper : {}) as Record<string, unknown>;
  return sanitizeUi({ ...current, ...p, wallpaper: { ...current.wallpaper, ...wp } }, current);
}
