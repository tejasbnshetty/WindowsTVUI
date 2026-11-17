// Wallpapers and custom app images: listing the user's folders and serving them safely over couch://.
import * as fs from "fs";
import * as path from "path";
import type { WallpaperFile } from "./ui/types";

export const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"] as const;
const CUSTOM_EXTENSIONS = [...IMAGE_EXTENSIONS, ".svg"] as const;

export const MIME: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml",
};

const hasExt = (name: string, exts: readonly string[]) => exts.includes(path.extname(name).toLowerCase());

/** Creates the folder if it is missing (e.g. %APPDATA%\Couch UI\wallpapers). Never throws. */
export function ensureDir(dir: string): boolean {
  try { fs.mkdirSync(dir, { recursive: true }); return true; } catch { return false; }
}

/** Image files directly inside `dir` (no subfolders), sorted by name. A missing/unreadable folder is just empty. */
export function listWallpapers(dir: string): WallpaperFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name);
  } catch {
    return [];
  }
  return names
    .filter((n) => hasExt(n, IMAGE_EXTENSIONS) && !n.startsWith("."))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))
    .map((name) => ({ name, url: `couch://wallpaper/${encodeURIComponent(name)}` }));
}

/**
 * Resolves a request path to a file strictly inside `root`. Returns null for anything that is not a plain
 * file name with an allowed extension: no separators, no "..", no drive letters, no encoded tricks.
 */
export function resolveInside(root: string, requested: string, allowed: readonly string[]): string | null {
  let name: string;
  try { name = decodeURIComponent(requested); } catch { return null; }
  if (!name || name.length > 255) return null;
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(name) || name === "." || name === ".." || name.includes("..")) return null;
  if (!hasExt(name, allowed)) return null;
  const full = path.resolve(root, name);
  const rel = path.relative(path.resolve(root), full);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return full;
}

export const resolveWallpaper = (root: string, requested: string) => resolveInside(root, requested, IMAGE_EXTENSIONS);
export const resolveCustom = (root: string, requested: string) => resolveInside(root, requested, CUSTOM_EXTENSIONS);

/** The custom image for an app: apps.json "image", else <id>.png/.svg/.jpg/.jpeg/.webp if present. */
export function findCustomImage(customDir: string, appId: string, explicit?: string): string | null {
  const candidates = explicit ? [explicit] : CUSTOM_EXTENSIONS.map((ext) => `${appId}${ext}`);
  for (const name of candidates) {
    const full = resolveCustom(customDir, name);
    try { if (full && fs.statSync(full).isFile()) return name; } catch { /* not there */ }
  }
  return null;
}

export const customImageUrl = (name: string) => `couch://asset/${encodeURIComponent(name)}`;
