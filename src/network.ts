// LAN address detection and change monitoring.
import * as os from "os";

export interface LanInfo {
  ip: string;
  /** Windows adapter name, e.g. "Wi-Fi" or "Ethernet". */
  iface: string;
  /** What to call it on screen. */
  label: "Wi-Fi" | "Network";
}

type Ifaces = NodeJS.Dict<os.NetworkInterfaceInfo[]>;

// Adapters that are virtual / tunnels: their addresses are not reachable from a phone on the Wi-Fi.
const VIRTUAL = /vEthernet|Hyper-V|WSL|VirtualBox|VMware|vmnet|VPN|TAP|TUN|Tailscale|ZeroTier|docker|Bluetooth|Loopback|Npcap|Teredo|isatap/i;
const WIFI = /wi-?fi|wlan|wireless/i;

/**
 * Picks the address the phone should use: the first non-internal IPv4 address, preferring real
 * Wi-Fi/Ethernet adapters over virtual ones (WSL, Hyper-V, VPNs) and skipping link-local 169.254.x.x.
 */
export function pickLan(ifaces: Ifaces): LanInfo | null {
  const real: LanInfo[] = [];
  const virtual: LanInfo[] = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs ?? []) {
      const family = a.family as string | number;
      if ((family !== "IPv4" && family !== 4) || a.internal || a.address.startsWith("169.254.")) continue;
      const info: LanInfo = { ip: a.address, iface: name, label: WIFI.test(name) ? "Wi-Fi" : "Network" };
      (VIRTUAL.test(name) ? virtual : real).push(info);
    }
  }
  // Wi-Fi first among real adapters (that is what a phone is on), then the rest in enumeration order.
  return real.find((i) => i.label === "Wi-Fi") ?? real[0] ?? virtual[0] ?? null;
}

export function getLanInfo(): LanInfo | null {
  return pickLan(os.networkInterfaces());
}

export function getLanIp(): string | null {
  return getLanInfo()?.ip ?? null;
}

export const sameLan = (a: LanInfo | null, b: LanInfo | null): boolean => a?.ip === b?.ip && a?.iface === b?.iface;

export interface NetworkMonitorDeps {
  read(): LanInfo | null;
  onChange(next: LanInfo | null, prev: LanInfo | null): void;
  intervalMs?: number;
  /** Replaceable in tests. */
  setInterval?(fn: () => void, ms: number): { stop(): void };
}

export interface NetworkMonitor {
  start(): void;
  stop(): void;
  /** Re-reads now (e.g. right after resume from sleep). Returns true if something changed. */
  check(): boolean;
  current(): LanInfo | null;
}

/**
 * Polls the adapter list every few seconds and reports changes (Wi-Fi dropped, reconnected,
 * new IP). This only OBSERVES the network from inside the running app; it never restarts anything
 * by itself and does not outlive the app.
 */
export function createNetworkMonitor(deps: NetworkMonitorDeps): NetworkMonitor {
  const every = deps.setInterval ?? ((fn, ms) => { const t = setInterval(fn, ms); t.unref(); return { stop: () => clearInterval(t) }; });
  let last = deps.read();
  let timer: { stop(): void } | null = null;

  function check(): boolean {
    const next = deps.read();
    if (sameLan(next, last)) return false;
    const prev = last;
    last = next;
    deps.onChange(next, prev);
    return true;
  }

  return {
    start() { if (!timer) timer = every(() => { check(); }, deps.intervalMs ?? 5000); },
    stop() { timer?.stop(); timer = null; },
    check,
    current: () => last,
  };
}
