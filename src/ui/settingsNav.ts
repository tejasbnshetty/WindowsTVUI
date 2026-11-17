// D-pad navigation inside the Settings screen.
//
//   menu (left column):  up/down = section,  right / OK = enter it,  back = leave Settings
//   pane (right):        up/down = item (info rows are skipped),
//                        left/right on a choice = change it,  OK = run an action / next choice,
//                        left on anything else, or back = return to the menu
import type { Dir } from "./nav";
import type { Section } from "./settingsModel";

export type SettingsFocus = { zone: "menu"; section: number } | { zone: "pane"; section: number; item: number };

export type SettingsEffect =
  | { type: "adjust"; section: number; item: number; dir: -1 | 1 }
  | { type: "activate"; section: number; item: number }
  | { type: "close" };

export interface SettingsStep {
  focus: SettingsFocus;
  effect?: SettingsEffect;
}

export type SettingsKey = Dir | "ok" | "back";

const focusable = (s: Section | undefined): number[] =>
  (s?.items ?? []).map((it, i) => (it.kind === "info" ? -1 : i)).filter((i) => i >= 0);

/** Re-validates a focus after the sections changed (items added/removed, e.g. a different wallpaper mode). */
export function clampSettingsFocus(sections: readonly Section[], f: SettingsFocus): SettingsFocus {
  const section = Math.max(0, Math.min(sections.length - 1, f.section));
  if (f.zone === "menu") return { zone: "menu", section };
  const ok = focusable(sections[section]);
  if (ok.length === 0) return { zone: "menu", section };
  if (ok.includes(f.item)) return { zone: "pane", section, item: f.item };
  const next = ok.find((i) => i > f.item) ?? ok[ok.length - 1];
  return { zone: "pane", section, item: next };
}

export function stepSettings(sections: readonly Section[], f: SettingsFocus, key: SettingsKey): SettingsStep {
  if (sections.length === 0) return { focus: f, effect: key === "back" ? { type: "close" } : undefined };

  if (f.zone === "menu") {
    switch (key) {
      case "up": return { focus: { zone: "menu", section: Math.max(0, f.section - 1) } };
      case "down": return { focus: { zone: "menu", section: Math.min(sections.length - 1, f.section + 1) } };
      case "right":
      case "ok": {
        const ok = focusable(sections[f.section]);
        return ok.length ? { focus: { zone: "pane", section: f.section, item: ok[0] } } : { focus: f };
      }
      case "back": return { focus: f, effect: { type: "close" } };
      default: return { focus: f }; // left
    }
  }

  const section = sections[f.section];
  const item = section?.items[f.item];
  const ok = focusable(section);
  const at = ok.indexOf(f.item);
  switch (key) {
    case "up": return { focus: { zone: "pane", section: f.section, item: ok[Math.max(0, at - 1)] ?? f.item } };
    case "down": return { focus: { zone: "pane", section: f.section, item: ok[Math.min(ok.length - 1, at + 1)] ?? f.item } };
    case "left":
      if (item?.kind === "choice") return { focus: f, effect: { type: "adjust", section: f.section, item: f.item, dir: -1 } };
      return { focus: { zone: "menu", section: f.section } };
    case "right":
      if (item?.kind === "choice") return { focus: f, effect: { type: "adjust", section: f.section, item: f.item, dir: 1 } };
      return { focus: f };
    case "ok":
      if (item?.kind === "choice") return { focus: f, effect: { type: "adjust", section: f.section, item: f.item, dir: 1 } };
      if (item?.kind === "action") return { focus: f, effect: { type: "activate", section: f.section, item: f.item } };
      return { focus: f };
    case "back": return { focus: { zone: "menu", section: f.section } };
  }
}
