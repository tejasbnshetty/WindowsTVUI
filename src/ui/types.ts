// Types shared by the Electron main process and the launcher UI (type-only: no runtime code here).
import type { DisplayView } from "../protocol";

export type { DisplayView };

export type LaunchType = "url" | "exe" | "store-app";

/** An app as the UI sees it (icons already resolved by the main process; nothing is downloaded at runtime). */
export interface PublicApp {
  id: string;
  name: string;
  category: string;
  type: LaunchType;
  /** Brand colour, "#rrggbb". */
  color: string;
  /** simple-icons SVG path (24x24 viewBox), or null -> the tile uses a generated wordmark. */
  iconPath: string | null;
  /** Custom image from assets/custom (served by the couch:// protocol), or null. */
  imageUrl: string | null;
  /** false = known to be missing (exe path not found); null = unknown / not applicable. */
  installed: boolean | null;
}

export interface WallpaperFile {
  name: string;
  /** couch://wallpaper/<name> */
  url: string;
}

export interface UiSettings {
  wallpaper: { mode: "single" | "rotate"; id: string; minutes: number };
  /** 0 = off. */
  screensaverMinutes: number;
  reduceEffects: boolean;
  lastLaunchedId: string | null;
}

export interface PairingView {
  open: boolean;
  pin: string | null;
  expiresAt: number | null;
}

/** What the launcher is told about the phone remote. Never contains a token; the PIN only while pairing is open. */
export interface LauncherInfo {
  error: string | null;
  url: string | null;
  mdnsUrl: string | null;
  qr: string | null;
  pairing: PairingView;
  /** Paired (remembered) phones. */
  devices: number;
  /** Phones connected right now. */
  connected: number;
  network: { online: boolean; label: string | null; ip: string | null };
}

export interface DeviceView {
  label: string;
  createdAt: number;
}

export interface AboutInfo {
  version: string;
  packaged: boolean;
  dataDir: string;
  configFile: string;
  appsFile: string;
  wallpapersDir: string;
}

export type LaunchResult =
  | { ok: true; lastLaunchedId: string }
  | { ok: false; code: "not-installed" | "failed" | "unknown-app"; message: string };

/** The bridge exposed by preload.ts as window.tv. */
export interface TvApi {
  getApps(): Promise<PublicApp[]>;
  getUi(): Promise<UiSettings>;
  setUi(patch: Partial<UiSettings>): Promise<UiSettings>;
  getWallpapers(): Promise<WallpaperFile[]>;
  getRemoteInfo(): Promise<LauncherInfo>;
  onInfo(cb: (info: LauncherInfo) => void): void;
  onNav(cb: (action: string) => void): void;
  launch(id: string): Promise<LaunchResult>;
  getDevices(): Promise<DeviceView[]>;
  forgetDevices(): Promise<void>;
  openPairing(): void;
  closePairing(): void;
  getDisplays(): Promise<DisplayView[]>;
  chooseDisplay(id: number | null): Promise<boolean>;
  getAbout(): Promise<AboutInfo>;
  openFolder(which: "wallpapers" | "data"): void;
  quit(): void;
}
