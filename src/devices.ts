// Remembered phones. Only SHA-256 hashes of device tokens are stored, never the tokens themselves,
// so a copy of devices.json cannot be used to impersonate a paired phone.
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

export const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export interface DeviceInfo {
  /** hashToken(token) */
  hash: string;
  label: string;
  createdAt: number;
}

export interface DeviceStore {
  has(hash: string): boolean;
  add(info: DeviceInfo): void;
  clear(): void;
  count(): number;
  list(): DeviceInfo[];
}

class MemoryStore implements DeviceStore {
  protected devices = new Map<string, DeviceInfo>();
  has(hash: string): boolean { return this.devices.has(hash); }
  add(info: DeviceInfo): void { this.devices.set(info.hash, info); }
  clear(): void { this.devices.clear(); }
  count(): number { return this.devices.size; }
  list(): DeviceInfo[] { return [...this.devices.values()]; }
}

export function createMemoryDeviceStore(): DeviceStore {
  return new MemoryStore();
}

function isDeviceInfo(v: unknown): v is DeviceInfo {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return typeof d.hash === "string" && TOKEN_PATTERN.test(d.hash)
    && typeof d.label === "string" && typeof d.createdAt === "number";
}

class FileStore extends MemoryStore {
  constructor(private readonly file: string) {
    super();
    this.load();
  }

  private load(): void {
    let text: string;
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch {
      return; // first run: nothing stored yet
    }
    try {
      const parsed = JSON.parse(text.replace(/^﻿/, ""));
      const list: unknown[] = Array.isArray(parsed?.devices) ? parsed.devices : [];
      for (const d of list) if (isDeviceInfo(d)) this.devices.set(d.hash, d);
    } catch {
      // Corrupt file: keep it for inspection, start with no paired devices (fail closed).
      try { fs.renameSync(this.file, `${this.file}.corrupt`); } catch { /* ignore */ }
      console.warn("devices.json was unreadable; all phones must be paired again");
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, devices: this.list() }, null, 2), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmp, this.file); // atomic replace
    } catch (err) {
      // Pairing still works for this session; it just won't survive a restart.
      console.error("Could not save paired devices:", err);
    }
  }

  override add(info: DeviceInfo): void { super.add(info); this.save(); }
  override clear(): void { super.clear(); this.save(); }
}

export function createFileDeviceStore(file: string): DeviceStore {
  return new FileStore(file);
}

/** A friendly label from the User-Agent, e.g. "iPhone". Only used for display. */
export function deviceLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return "Android phone";
  return "Browser";
}
