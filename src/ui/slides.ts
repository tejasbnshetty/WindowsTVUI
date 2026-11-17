// Wallpaper choice, rotation and the screensaver slideshow order.
import type { UiSettings, WallpaperFile } from "./types";

export interface WallpaperOption {
  /** "builtin:aurora" or "file:<name>" */
  id: string;
  name: string;
  /** Present for files from the user's folder. */
  url?: string;
}

/** Built-in generated gradients (drawn with CSS in styles.css as .wp-<key>). */
export const BUILTIN_WALLPAPERS: ReadonlyArray<{ key: string; name: string }> = [
  { key: "aurora", name: "Aurora" },
  { key: "ember", name: "Ember" },
  { key: "ocean", name: "Ocean" },
  { key: "midnight", name: "Midnight" },
];

export function wallpaperOptions(files: readonly WallpaperFile[]): WallpaperOption[] {
  return [
    ...BUILTIN_WALLPAPERS.map((b) => ({ id: `builtin:${b.key}`, name: b.name })),
    ...files.map((f) => ({ id: `file:${f.name}`, name: f.name.replace(/\.[^.]+$/, ""), url: f.url })),
  ];
}

/** The wallpaper to show right now. A chosen file that has since been deleted falls back to the first option. */
export function activeWallpaper(ui: UiSettings["wallpaper"], options: readonly WallpaperOption[], rotateIndex: number): WallpaperOption {
  if (ui.mode === "rotate" && options.length > 0) return options[((rotateIndex % options.length) + options.length) % options.length];
  return options.find((o) => o.id === ui.id) ?? options[0];
}

export const nextIndex = (i: number, n: number): number => (n <= 0 ? 0 : (i + 1) % n);

/** Small deterministic PRNG (mulberry32) so slideshow order is reproducible in tests. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Screensaver slides: the user's photos (shuffled) if there are any, otherwise the built-in wallpapers.
 * Never empty.
 */
export function slideshowOrder(options: readonly WallpaperOption[], rand: () => number): WallpaperOption[] {
  const photos = options.filter((o) => o.url);
  const pool = photos.length > 0 ? photos : options.filter((o) => !o.url);
  const out = [...pool];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
