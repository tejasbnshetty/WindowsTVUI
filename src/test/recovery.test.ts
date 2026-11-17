import { test } from "node:test";
import * as assert from "node:assert/strict";
import type { LanInfo } from "../network";
import { createRecovery } from "../recovery";

const wifi = (ip: string): LanInfo => ({ ip, iface: "Wi-Fi", label: "Wi-Fi" });

function fixture(opts: { net?: LanInfo | null; healthy?: boolean | (() => boolean); restartThrows?: boolean; probeThrows?: boolean; refreshThrows?: boolean } = {}) {
  const calls: string[] = [];
  let net: LanInfo | null = opts.net === undefined ? wifi("192.168.1.10") : opts.net;
  let healthy: boolean | (() => boolean) = opts.healthy ?? true;
  const sleeps: number[] = [];
  const recovery = createRecovery({
    readNetwork: () => net,
    probeServer: async () => {
      calls.push("probe");
      if (opts.probeThrows) throw new Error("probe exploded");
      return typeof healthy === "function" ? healthy() : healthy;
    },
    restartServer: async () => {
      calls.push("restart");
      if (opts.restartThrows) throw new Error("EADDRINUSE");
      healthy = true;
    },
    updateMdns: (ip) => calls.push(`mdns:${ip}`),
    refreshDisplays: () => { calls.push("displays"); if (opts.refreshThrows) throw new Error("display api failed"); },
    publish: () => calls.push("publish"),
    sleep: async (ms) => { sleeps.push(ms); },
    log: () => {},
    settleMs: 3000,
  });
  return { recovery, calls, sleeps, setNet: (n: LanInfo | null) => { net = n; }, setHealthy: (h: boolean) => { healthy = h; } };
}

test("resume from sleep: waits for Wi-Fi to settle, then re-points mDNS, checks the server, re-detects displays, refreshes the UI", async () => {
  const f = fixture();
  await f.recovery.onResume();
  assert.deepEqual(f.sleeps, [3000], "waits before trusting the network");
  assert.deepEqual(f.calls, ["mdns:192.168.1.10", "probe", "displays", "publish"]);
});

test("a healthy server is NOT restarted", async () => {
  const f = fixture({ healthy: true });
  await f.recovery.onResume();
  assert.ok(!f.calls.includes("restart"));
});

test("a server that stopped answering is re-bound, and the displays/UI refresh still happens afterwards", async () => {
  const f = fixture({ healthy: false });
  await f.recovery.onResume();
  assert.deepEqual(f.calls, ["mdns:192.168.1.10", "probe", "restart", "displays", "publish"]);
});

test("network lost: mDNS is told 'no address'; the pass still completes and the UI shows it", async () => {
  const f = fixture({ net: null });
  await f.recovery.onNetworkChange();
  assert.equal(f.calls[0], "mdns:null");
  assert.ok(f.calls.includes("publish"));
});

test("network back with a NEW address: mDNS follows the new IP", async () => {
  const f = fixture({ net: wifi("192.168.1.10") });
  await f.recovery.onNetworkChange();
  f.setNet(wifi("192.168.1.99"));
  await f.recovery.onNetworkChange();
  assert.deepEqual(f.calls.filter((c) => c.startsWith("mdns")), ["mdns:192.168.1.10", "mdns:192.168.1.99"]);
});

test("a failing restart (e.g. port taken) is contained; the rest of recovery still runs", async () => {
  const f = fixture({ healthy: false, restartThrows: true });
  await assert.doesNotReject(f.recovery.onResume());
  assert.deepEqual(f.calls.slice(-2), ["displays", "publish"]);
});

test("a probe that throws is treated as unhealthy", async () => {
  const f = fixture({ probeThrows: true });
  await f.recovery.onNetworkChange();
  assert.ok(f.calls.includes("restart"));
});

test("a display-refresh failure does not stop the UI refresh", async () => {
  const f = fixture({ refreshThrows: true });
  await assert.doesNotReject(f.recovery.onNetworkChange());
  assert.equal(f.calls.at(-1), "publish");
});

test("a burst of events is coalesced: at most one extra pass, never overlapping runs", async () => {
  let active = 0, maxActive = 0;
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let first = true;
  const recovery = createRecovery({
    readNetwork: () => wifi("10.0.0.1"),
    probeServer: async () => {
      active++; maxActive = Math.max(maxActive, active);
      calls.push("probe");
      if (first) { first = false; await gate; } // hold the first pass open while more events arrive
      active--;
      return true;
    },
    restartServer: async () => {},
    updateMdns: () => {},
    refreshDisplays: () => {},
    publish: () => {},
    sleep: async () => {},
  });
  const a = recovery.onNetworkChange();
  const b = recovery.onNetworkChange();
  const c = recovery.onNetworkChange();
  const d = recovery.onNetworkChange();
  release();
  await Promise.all([a, b, c, d]);
  assert.equal(maxActive, 1, "passes never run concurrently");
  assert.equal(calls.length, 2, "4 events during one pass -> exactly one follow-up pass");
});

test("resume and network-change recoveries share the same guard", async () => {
  const f = fixture({ healthy: false });
  await Promise.all([f.recovery.onResume(), f.recovery.onNetworkChange()]);
  assert.ok(f.calls.filter((c) => c === "restart").length >= 1);
});
