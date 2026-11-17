// Which pairing UI to show, derived from what the main process reports. Pure, so it is easy to test.
import type { LauncherInfo } from "./types";

export type PairingScreen =
  /** No phone has EVER been paired: full-screen "Connect your phone". Pairing is open. */
  | { kind: "connect"; online: boolean }
  /** A phone was asked to pair (Settings > Devices, P key, or the remote's "Pair new device"): full-screen QR + PIN with a countdown. */
  | { kind: "pair-new"; expiresAt: number | null; online: boolean }
  /** Normal home screen. */
  | { kind: "home" };

export interface PairingChips {
  /** Paired phones exist but none is connected: small "Waiting for your phone…" chip. */
  waitingForPhone: boolean;
  /** At least one phone is connected right now. */
  phoneConnected: boolean;
}

export interface PairingUi {
  screen: PairingScreen;
  chips: PairingChips;
}

const NO_CHIPS: PairingChips = { waitingForPhone: false, phoneConnected: false };

export function derivePairing(info: LauncherInfo | null): PairingUi {
  if (!info) return { screen: { kind: "home" }, chips: NO_CHIPS };
  // A fatal remote problem (e.g. port busy) is shown as the red banner on the home screen instead.
  if (info.error) return { screen: { kind: "home" }, chips: NO_CHIPS };

  const online = info.network.online;
  if (info.devices === 0) {
    return { screen: { kind: "connect", online }, chips: NO_CHIPS };
  }
  if (info.pairing.open && info.pairing.pin) {
    return { screen: { kind: "pair-new", expiresAt: info.pairing.expiresAt, online }, chips: NO_CHIPS };
  }
  const connected = info.connected > 0;
  return { screen: { kind: "home" }, chips: { phoneConnected: connected, waitingForPhone: !connected } };
}

/** "1:45" style countdown, never negative. */
export function formatCountdown(expiresAt: number | null, now: number): string {
  if (expiresAt === null) return "";
  const total = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
