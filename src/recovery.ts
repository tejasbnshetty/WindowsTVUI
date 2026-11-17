// Getting back on the air after Wi-Fi drops or the laptop sleeps.
//
// This is NOT a watchdog: nothing here runs outside the app, nothing restarts the app, and it only
// acts when told something happened (network change, resume from sleep). Inside the running app it
//   1. re-reads the LAN address and re-points the mDNS announcement,
//   2. checks the HTTP/WebSocket server still answers and re-binds it if it does not,
//   3. re-detects displays (HDMI often re-enumerates after sleep),
//   4. refreshes the launcher panel and tells the connected phones.

import type { LanInfo } from "./network";

export interface RecoveryDeps {
  readNetwork(): LanInfo | null;
  /** True if the server answers on loopback. */
  probeServer(): Promise<boolean>;
  restartServer(): Promise<void>;
  updateMdns(ip: string | null): void;
  refreshDisplays(): void;
  /** Refresh the launcher panel and push state to the phones. */
  publish(): void;
  log?(msg: string): void;
  sleep?(ms: number): Promise<void>;
  /** After resume, Wi-Fi needs a few seconds to reconnect before the network can be trusted. */
  settleMs?: number;
}

export interface Recovery {
  onResume(): Promise<void>;
  onNetworkChange(): Promise<void>;
}

export function createRecovery(deps: RecoveryDeps): Recovery {
  const log = deps.log ?? (() => {});
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const settleMs = deps.settleMs ?? 3000;

  let running = false;
  let again = false;

  async function run(reason: string): Promise<void> {
    if (running) { again = true; return; } // coalesce bursts of events into one more pass
    running = true;
    try {
      do {
        again = false;
        const lan = deps.readNetwork();
        log(`recovery (${reason}): network ${lan ? `${lan.label} ${lan.ip}` : "down"}`);
        deps.updateMdns(lan?.ip ?? null);

        // A bound socket normally survives Wi-Fi drops and sleep; only re-bind if it really stopped answering.
        let healthy = false;
        try { healthy = await deps.probeServer(); } catch { healthy = false; }
        if (!healthy) {
          log("recovery: server not answering, re-binding");
          try { await deps.restartServer(); } catch (err) { log(`recovery: restart failed: ${String(err)}`); }
        }

        try { deps.refreshDisplays(); } catch (err) { log(`recovery: display refresh failed: ${String(err)}`); }
        deps.publish();
      } while (again);
    } finally {
      running = false;
    }
  }

  return {
    async onResume() {
      log("resumed from sleep");
      await sleep(settleMs);
      await run("resume");
    },
    onNetworkChange: () => run("network change"),
  };
}
