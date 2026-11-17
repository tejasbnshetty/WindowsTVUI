// Which display the launcher lives on, and moving it when the user asks or monitors come and go.
import type { DisplayView } from "./protocol";
import type { SavedDisplay } from "./settings";

export interface Rect { x: number; y: number; width: number; height: number }

export interface DisplayInfo extends Rect {
  id: number;
  label: string;
  primary: boolean;
}

/** config.json "display": absent/"auto" = the display the launcher started on. */
export type DisplayConfig = undefined | "auto" | "primary" | number | string;

export type DisplaySource = "saved" | "config" | "started" | "primary";

export interface ResolveOptions {
  saved?: SavedDisplay | null;
  config?: DisplayConfig;
  /** The display that was under the cursor when the launcher started. */
  startedOnId?: number | null;
}

function matchSaved(displays: DisplayInfo[], saved: SavedDisplay): DisplayInfo | undefined {
  return displays.find((d) => d.id === saved.id)
    // ids can change across re-plugs; the same monitor keeps its label and resolution
    ?? (saved.label ? displays.find((d) => d.label === saved.label && d.width === saved.width && d.height === saved.height) : undefined);
}

function matchConfig(displays: DisplayInfo[], config: DisplayConfig): DisplayInfo | undefined {
  if (config === undefined || config === "auto") return undefined;
  if (config === "primary") return displays.find((d) => d.primary);
  if (typeof config === "number") return displays.find((d) => d.id === config);
  if (typeof config === "string" && config.trim()) {
    const needle = config.trim().toLowerCase();
    return displays.find((d) => d.label.toLowerCase().includes(needle));
  }
  return undefined;
}

/**
 * Precedence: choice made from the remote > config.json > the display it started on > primary.
 * A choice that is currently unplugged is skipped (not forgotten), so re-plugging the TV moves
 * the launcher back to it.
 */
export function resolveDisplay(displays: DisplayInfo[], o: ResolveOptions): { display: DisplayInfo; source: DisplaySource } | null {
  if (displays.length === 0) return null;
  if (o.saved) {
    const d = matchSaved(displays, o.saved);
    if (d) return { display: d, source: "saved" };
  }
  const c = matchConfig(displays, o.config);
  if (c) return { display: c, source: "config" };
  if (o.startedOnId != null) {
    const d = displays.find((x) => x.id === o.startedOnId);
    if (d) return { display: d, source: "started" };
  }
  return { display: displays.find((d) => d.primary) ?? displays[0], source: "primary" };
}

/** The display containing the middle of a rectangle (falls back to the largest overlap). */
export function displayContaining(displays: DisplayInfo[], r: Rect): DisplayInfo | undefined {
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  const hit = displays.find((d) => cx >= d.x && cx < d.x + d.width && cy >= d.y && cy < d.y + d.height);
  if (hit) return hit;
  let best: DisplayInfo | undefined;
  let bestArea = 0;
  for (const d of displays) {
    const w = Math.min(r.x + r.width, d.x + d.width) - Math.max(r.x, d.x);
    const h = Math.min(r.y + r.height, d.y + d.height) - Math.max(r.y, d.y);
    if (w > 0 && h > 0 && w * h > bestArea) { best = d; bestArea = w * h; }
  }
  return best;
}

const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

export interface WindowLike {
  isDestroyed(): boolean;
  getBounds(): Rect;
  setBounds(r: Rect): void;
  isFullScreen(): boolean;
  setFullScreen(on: boolean): void;
  once(event: "leave-full-screen", cb: () => void): void;
}

export interface DisplayManagerDeps {
  listDisplays(): DisplayInfo[];
  /** Calls back on display-added / display-removed / display-metrics-changed. Returns an unsubscribe. */
  subscribe(cb: () => void): () => void;
  getWindow(): WindowLike | null;
  getSaved(): SavedDisplay | null;
  setSaved(d: SavedDisplay | null): void;
  config: DisplayConfig;
  startedOnId: number | null;
  /** Called after every apply() so the remote's display list can be refreshed. */
  onChange?(): void;
  /** Replaceable in tests. */
  schedule?(fn: () => void, ms: number): { cancel(): void };
  debounceMs?: number;
}

export interface DisplayManager {
  /** Resolves the display and moves the window if it is not already there. */
  apply(): void;
  /** Pick a display from the remote (null = back to the default). Returns false for an unknown id. */
  choose(id: number | null): boolean;
  views(): DisplayView[];
  dispose(): void;
}

export function createDisplayManager(deps: DisplayManagerDeps): DisplayManager {
  const schedule = deps.schedule ?? ((fn, ms) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; });
  const debounceMs = deps.debounceMs ?? 400;
  let moving = false;
  let again = false;
  let debounce: { cancel(): void } | null = null;

  function target(): DisplayInfo | null {
    return resolveDisplay(deps.listDisplays(), { saved: deps.getSaved(), config: deps.config, startedOnId: deps.startedOnId })?.display ?? null;
  }

  function moveTo(win: WindowLike, t: DisplayInfo): void {
    const rect: Rect = { x: t.x, y: t.y, width: t.width, height: t.height };
    const finish = () => {
      moving = false;
      if (win.isDestroyed()) return;
      win.setBounds(rect);
      win.setFullScreen(true);
      if (again) { again = false; apply(); } else deps.onChange?.();
    };
    moving = true;
    if (win.isFullScreen()) {
      // Fullscreen windows ignore setBounds: leave fullscreen first, then move, then re-enter on the new display.
      let done = false;
      const once = () => { if (!done) { done = true; timer.cancel(); finish(); } };
      const timer = schedule(once, 800); // in case 'leave-full-screen' never fires
      win.once("leave-full-screen", once);
      win.setFullScreen(false);
    } else {
      finish();
    }
  }

  function apply(): void {
    const win = deps.getWindow();
    if (!win || win.isDestroyed()) return;
    if (moving) { again = true; return; }
    const t = target();
    if (!t) return;
    const current = displayContaining(deps.listDisplays(), win.getBounds());
    const bounds = win.getBounds();
    if (current?.id === t.id && sameRect(bounds, t) && win.isFullScreen()) {
      deps.onChange?.();
      return;
    }
    moveTo(win, t);
  }

  const unsubscribe = deps.subscribe(() => {
    // Monitors announce themselves in bursts; wait for things to settle.
    debounce?.cancel();
    debounce = schedule(() => { debounce = null; apply(); deps.onChange?.(); }, debounceMs);
  });

  return {
    apply,
    choose(id) {
      if (id === null) {
        deps.setSaved(null);
      } else {
        const d = deps.listDisplays().find((x) => x.id === id);
        if (!d) return false;
        deps.setSaved({ id: d.id, label: d.label, width: d.width, height: d.height });
      }
      apply();
      return true;
    },
    views() {
      const list = deps.listDisplays();
      const win = deps.getWindow();
      const cur = win && !win.isDestroyed() ? displayContaining(list, win.getBounds()) : undefined;
      return list.map((d, i) => ({
        id: d.id,
        label: d.label || `Display ${i + 1}`,
        width: d.width,
        height: d.height,
        primary: d.primary,
        current: d.id === cur?.id,
      }));
    },
    dispose() {
      debounce?.cancel();
      unsubscribe();
    },
  };
}
