// What the Settings screen contains. Pure: the controller feeds it data and renders / navigates the result.
import { ROTATE_OPTIONS, SCREENSAVER_OPTIONS } from "../uiSettings";
import type { AboutInfo, DeviceView, DisplayView, UiSettings } from "./types";
import type { WallpaperOption } from "./slides";

export type SectionId = "display" | "wallpaper" | "screensaver" | "devices" | "addapp" | "about";

export type Item =
  /** Left/Right cycle through the options; OK also moves to the next one. */
  | { id: string; kind: "choice"; label: string; value: string }
  /** OK runs it. `armed` = the first press of a two-step confirm. */
  | { id: string; kind: "action"; label: string; hint?: string; danger?: boolean; armed?: boolean; current?: boolean }
  /** Read-only text; skipped by navigation. */
  | { id: string; kind: "info"; label: string; value?: string; /** Show the value in a monospace font (file paths). */ mono?: boolean };

export interface Section {
  id: SectionId;
  title: string;
  items: Item[];
}

export interface SettingsData {
  displays: DisplayView[];
  devices: DeviceView[];
  wallpapers: WallpaperOption[];
  about: AboutInfo | null;
  ui: UiSettings;
  /** Id of an action waiting for its second press (e.g. "dev-forget"), or null. */
  armed: string | null;
}

export const MENU: ReadonlyArray<{ id: SectionId; title: string }> = [
  { id: "display", title: "Display" },
  { id: "wallpaper", title: "Wallpaper" },
  { id: "screensaver", title: "Screensaver" },
  { id: "devices", title: "Devices" },
  { id: "addapp", title: "Add app" },
  { id: "about", title: "About / Exit" },
];

export const minutesLabel = (m: number): string => (m <= 0 ? "Off" : m === 1 ? "1 minute" : `${m} minutes`);

export function buildSections(d: SettingsData): Section[] {
  const armed = (id: string) => d.armed === id;

  const display: Item[] = [
    ...(d.displays.length === 0
      ? [{ id: "display-none", kind: "info", label: "No displays found" } as Item]
      : d.displays.map((x): Item => ({
        id: `display:${x.id}`,
        kind: "action",
        label: `${x.label} (${x.width} × ${x.height})`,
        hint: x.current ? "Launcher is here" : "Move launcher here",
        current: x.current,
      }))),
    { id: "display-reset", kind: "action", label: "Use the default display", hint: "config.json, else the screen it started on" },
    { id: "reduce-fx", kind: "choice", label: "Reduce effects", value: d.ui.reduceEffects ? "On" : "Off" },
    { id: "display-note", kind: "info", label: "Turn on Reduce effects if animations stutter: it removes blur and heavy glow." },
  ];

  const wp = d.ui.wallpaper;
  const current = d.wallpapers.find((o) => o.id === wp.id) ?? d.wallpapers[0];
  const wallpaper: Item[] = [
    { id: "wp-mode", kind: "choice", label: "Mode", value: wp.mode === "rotate" ? "Rotate" : "Single" },
    ...(wp.mode === "rotate"
      ? [{ id: "wp-minutes", kind: "choice", label: "Change every", value: minutesLabel(wp.minutes) } as Item]
      : [{ id: "wp-pick", kind: "choice", label: "Wallpaper", value: current?.name ?? "—" } as Item]),
    { id: "wp-folder", kind: "action", label: "Open wallpapers folder", hint: "Add jpg, png or webp files" },
    { id: "wp-note", kind: "info", label: "Your pictures also play as the screensaver slideshow." },
  ];

  const screensaver: Item[] = [
    { id: "ss-minutes", kind: "choice", label: "Start after", value: d.ui.screensaverMinutes <= 0 ? "Off" : minutesLabel(d.ui.screensaverMinutes) + " idle" },
    { id: "ss-preview", kind: "action", label: "Preview now" },
    { id: "ss-note", kind: "info", label: "Only runs on the launcher. Any key or remote input wakes it without doing anything." },
  ];

  const devices: Item[] = [
    ...(d.devices.length === 0
      ? [{ id: "dev-none", kind: "info", label: "No phones paired yet" } as Item]
      : d.devices.map((p, i): Item => ({ id: `dev:${i}`, kind: "info", label: p.label, value: `paired ${new Date(p.createdAt).toLocaleDateString()}` }))),
    { id: "dev-pair", kind: "action", label: "Pair new device", hint: "Shows a QR code and PIN for 2 minutes" },
    { id: "dev-forget", kind: "action", label: armed("dev-forget") ? "Press OK again to forget every phone" : "Forget all devices", danger: true, armed: armed("dev-forget") },
  ];

  const addapp: Item[] = [
    { id: "addapp-soon", kind: "info", label: "Adding apps from the TV is coming in M7." },
    { id: "addapp-file", kind: "info", label: "For now, edit apps.json", value: d.about?.appsFile ?? "", mono: true },
  ];

  const about: Item[] = [
    { id: "about-version", kind: "info", label: "Couch UI", value: d.about ? `version ${d.about.version}` : "" },
    { id: "about-data", kind: "info", label: "Data folder", value: d.about?.dataDir ?? "", mono: true },
    { id: "open-data", kind: "action", label: "Open data folder" },
    { id: "exit", kind: "action", label: armed("exit") ? "Press OK again to exit" : "Exit launcher", danger: true, armed: armed("exit"), hint: armed("exit") ? undefined : "Esc on the keyboard also exits" },
  ];

  const byId: Record<SectionId, Item[]> = { display, wallpaper, screensaver, devices, addapp, about };
  return MENU.map((m) => ({ id: m.id, title: m.title, items: byId[m.id] }));
}

export function nextChoice<T>(options: readonly T[], current: T, dir: -1 | 1): T {
  const i = options.indexOf(current);
  const n = options.length;
  return options[(((i < 0 ? 0 : i) + dir) % n + n) % n];
}

export const SCREENSAVER_CHOICES = SCREENSAVER_OPTIONS;
export const ROTATE_CHOICES = ROTATE_OPTIONS;
