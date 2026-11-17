// The app catalogue (apps.json) and launching apps. Everything environment-specific is injected so it is
// testable without touching the system: the real implementations live in main.ts.
import * as fs from "fs";
import type { LaunchType } from "./ui/types";
import { resolveBrowser, type BrowserDeps } from "./browser";
import { expandEnv } from "./env";
export { CATEGORY_ORDER, groupByCategory } from "./categories";

export { expandEnv };

export interface AppDef {
  id: string;
  name: string;
  category: string;
  launch: LaunchType;
  /** URL, executable path (may contain %ENV% variables) or a Windows Store AppUserModelID / protocol. */
  target: string;
  color: string;
  /** simple-icons slug. Optional: apps without a logo get a generated wordmark tile. */
  icon?: string;
  /** Optional custom image file name inside <app data>\assets\custom\ (default: <id>.png/.svg/.jpg/.webp is auto-detected). */
  image?: string;
}

export const DEFAULT_CATEGORY = "Apps";

const ID = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const COLOR = /^#[0-9a-f]{6}$/i;
const ICON = /^[a-z0-9]{1,60}$/;
// A bare file name only: no folders, no traversal.
const IMAGE = /^[\w][\w .()+-]{0,100}\.(png|jpe?g|webp|svg)$/i;
const LAUNCH_TYPES: ReadonlySet<string> = new Set<LaunchType>(["url", "exe", "store-app"]);

export interface ParsedApps {
  apps: AppDef[];
  /** Human-readable reasons entries were skipped (also logged). */
  problems: string[];
}

/** Validates apps.json. Bad entries are skipped (with a reason) instead of taking the whole launcher down. */
export function parseApps(raw: unknown): ParsedApps {
  const problems: string[] = [];
  const list = typeof raw === "object" && raw !== null && Array.isArray((raw as { apps?: unknown }).apps)
    ? (raw as { apps: unknown[] }).apps
    : null;
  if (!list) return { apps: [], problems: ['apps.json must look like { "apps": [ ... ] }'] };

  const seen = new Set<string>();
  const apps: AppDef[] = [];
  list.forEach((entry, i) => {
    const where = `apps[${i}]`;
    if (typeof entry !== "object" || entry === null) { problems.push(`${where}: not an object`); return; }
    const e = entry as Record<string, unknown>;
    const id = e.id;
    if (typeof id !== "string" || !ID.test(id)) { problems.push(`${where}: invalid id`); return; }
    if (seen.has(id)) { problems.push(`${where}: duplicate id "${id}"`); return; }
    const name = typeof e.name === "string" ? e.name.trim() : "";
    if (!name || name.length > 40) { problems.push(`${where} (${id}): name must be 1-40 characters`); return; }
    if (typeof e.launch !== "string" || !LAUNCH_TYPES.has(e.launch)) { problems.push(`${where} (${id}): launch must be url, exe or store-app`); return; }
    const target = typeof e.target === "string" ? e.target.trim() : "";
    if (!target || target.length > 1000) { problems.push(`${where} (${id}): missing target`); return; }
    if (e.launch === "url" && !/^https?:\/\//i.test(target)) { problems.push(`${where} (${id}): url targets must start with http:// or https://`); return; }

    seen.add(id);
    apps.push({
      id,
      name,
      category: typeof e.category === "string" && e.category.trim() && e.category.length <= 30 ? e.category.trim() : DEFAULT_CATEGORY,
      launch: e.launch as LaunchType,
      target,
      color: typeof e.color === "string" && COLOR.test(e.color) ? e.color : "#334155",
      ...(typeof e.icon === "string" && ICON.test(e.icon) ? { icon: e.icon } : {}),
      ...(typeof e.image === "string" && IMAGE.test(e.image) ? { image: e.image } : {}),
    });
  });
  return { apps, problems };
}

export function loadApps(file: string): ParsedApps {
  try {
    return parseApps(JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")));
  } catch (err) {
    return { apps: [], problems: [`Could not read ${file}: ${(err as Error).message}`] };
  }
}

// ---------------------------------------------------------------------------
// Launching
// ---------------------------------------------------------------------------

export type LaunchOutcome =
  | { ok: true }
  | { ok: false; code: "not-installed" | "failed"; message: string };

export interface LaunchDeps extends BrowserDeps {
  /** Opens a URL in the user's default browser. */
  openExternal(url: string): Promise<void>;
  /** Starts a program detached (does not wait for it). Rejects if it cannot be started. */
  spawnDetached(file: string, args: string[]): Promise<void>;
  /** AppIDs of installed Store apps, or null if they could not be listed. */
  listStoreApps(): Promise<Set<string> | null>;
  /** "default" or a browser name/path from config.json. */
  browser: string | undefined;
}

const isProtocolTarget = (t: string) => /^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[a-z]:[\\/]/i.test(t);

export async function launchApp(app: AppDef, deps: LaunchDeps): Promise<LaunchOutcome> {
  try {
    switch (app.launch) {
      case "url": {
        const b = resolveBrowser(deps.browser, deps);
        if (b.kind === "exe") {
          await deps.spawnDetached(b.path, [app.target]);
        } else {
          // "default", or a browser that is not installed: fall back to the default browser rather than failing.
          await deps.openExternal(app.target);
        }
        return { ok: true };
      }
      case "exe": {
        const file = expandEnv(app.target, deps.env);
        if (!deps.exists(file)) {
          return { ok: false, code: "not-installed", message: `${app.name} isn't installed (not found: ${file})` };
        }
        await deps.spawnDetached(file, []);
        return { ok: true };
      }
      case "store-app": {
        if (isProtocolTarget(app.target)) {
          await deps.openExternal(app.target); // e.g. ms-windows-store:, spotify:
          return { ok: true };
        }
        const installed = await deps.listStoreApps();
        // If the list is unavailable we still try: the user configured this app deliberately.
        if (installed && !installed.has(app.target)) {
          return { ok: false, code: "not-installed", message: `${app.name} isn't installed` };
        }
        await deps.spawnDetached("explorer.exe", [`shell:AppsFolder\\${app.target}`]);
        return { ok: true };
      }
    }
  } catch (err) {
    return { ok: false, code: "failed", message: `Could not open ${app.name}: ${(err as Error).message}` };
  }
}

/** Whether an app is known to be missing, for the "Not installed" badge. null = unknown / not applicable. */
export function installedState(app: AppDef, deps: { exists(p: string): boolean; env: NodeJS.ProcessEnv }): boolean | null {
  if (app.launch === "exe") return deps.exists(expandEnv(app.target, deps.env));
  return null;
}
