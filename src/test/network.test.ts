import { test } from "node:test";
import * as assert from "node:assert/strict";
import type * as os from "os";
import { LanInfo, createNetworkMonitor, pickLan, sameLan } from "../network";

const v4 = (address: string, internal = false): os.NetworkInterfaceInfo => ({
  address, netmask: "255.255.255.0", family: "IPv4", mac: "aa:bb:cc:dd:ee:ff", internal, cidr: `${address}/24`,
});
const v6 = (address: string): os.NetworkInterfaceInfo => ({
  address, netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "aa:bb:cc:dd:ee:ff", internal: false, cidr: `${address}/64`, scopeid: 0,
});

test("pickLan: simple Wi-Fi laptop", () => {
  const lan = pickLan({ "Wi-Fi": [v6("fe80::1"), v4("192.168.1.229")], "Loopback Pseudo-Interface 1": [v4("127.0.0.1", true)] });
  assert.deepEqual(lan, { ip: "192.168.1.229", iface: "Wi-Fi", label: "Wi-Fi" });
});

test("pickLan: virtual adapters (WSL, Hyper-V, VPN, VirtualBox) never beat a real adapter, even when listed first", () => {
  const lan = pickLan({
    "vEthernet (WSL)": [v4("172.24.48.1")],
    "VirtualBox Host-Only Network": [v4("192.168.56.1")],
    "Tailscale": [v4("100.64.0.5")],
    "Wi-Fi": [v4("192.168.1.50")],
  });
  assert.equal(lan?.ip, "192.168.1.50");
});

test("pickLan: Wi-Fi is preferred over Ethernet; Ethernet alone is labelled generically", () => {
  assert.equal(pickLan({ Ethernet: [v4("10.0.0.2")], "Wi-Fi": [v4("10.0.0.3")] })?.ip, "10.0.0.3");
  assert.deepEqual(pickLan({ Ethernet: [v4("10.0.0.2")] }), { ip: "10.0.0.2", iface: "Ethernet", label: "Network" });
  assert.equal(pickLan({ "WLAN 2": [v4("10.1.1.1")] })?.label, "Wi-Fi");
  assert.equal(pickLan({ "Wireless Network Connection": [v4("10.1.1.1")] })?.label, "Wi-Fi");
});

test("pickLan: link-local (169.254.x.x), loopback and IPv6-only adapters are ignored", () => {
  assert.equal(pickLan({ "Wi-Fi": [v4("169.254.10.10")] }), null);
  assert.equal(pickLan({ Loopback: [v4("127.0.0.1", true)] }), null);
  assert.equal(pickLan({ "Wi-Fi": [v6("2001:db8::1")] }), null);
  assert.equal(pickLan({}), null);
  assert.equal(pickLan({ "Wi-Fi": undefined }), null);
});

test("pickLan: with ONLY virtual adapters it still returns one (better than nothing)", () => {
  assert.equal(pickLan({ "vEthernet (Default Switch)": [v4("172.20.0.1")] })?.ip, "172.20.0.1");
});

test("pickLan: tolerates the numeric family (4) some Node versions report", () => {
  const legacy = { address: "192.168.5.5", netmask: "x", family: 4 as unknown as "IPv4", mac: "a", internal: false, cidr: "x" };
  assert.equal(pickLan({ "Wi-Fi": [legacy] })?.ip, "192.168.5.5");
});

test("sameLan compares ip + adapter", () => {
  const a: LanInfo = { ip: "1.1.1.1", iface: "Wi-Fi", label: "Wi-Fi" };
  assert.ok(sameLan(a, { ...a }));
  assert.ok(!sameLan(a, { ...a, ip: "1.1.1.2" }));
  assert.ok(!sameLan(a, null));
  assert.ok(sameLan(null, null));
});

// ---------------- monitor (fake clock, nothing real) ----------------

function monitorFixture(initial: LanInfo | null) {
  let net: LanInfo | null = initial;
  const events: Array<[LanInfo | null, LanInfo | null]> = [];
  let tick: (() => void) | null = null;
  let stopped = false;
  const m = createNetworkMonitor({
    read: () => net,
    onChange: (next, prev) => events.push([next, prev]),
    intervalMs: 5000,
    setInterval: (fn) => { tick = fn; return { stop: () => { stopped = true; tick = null; } }; },
  });
  return { m, events, set: (n: LanInfo | null) => { net = n; }, tick: () => tick?.(), isStopped: () => stopped, hasTimer: () => tick !== null };
}

const wifi = (ip: string): LanInfo => ({ ip, iface: "Wi-Fi", label: "Wi-Fi" });

test("monitor: reports Wi-Fi dropping, coming back, and a changed IP (and nothing in between)", () => {
  const f = monitorFixture(wifi("192.168.1.10"));
  f.m.start();
  f.tick();
  assert.equal(f.events.length, 0, "no change, no event");

  f.set(null); f.tick(); // Wi-Fi dropped
  assert.deepEqual(f.events.at(-1), [null, wifi("192.168.1.10")]);
  f.tick();
  assert.equal(f.events.length, 1, "still down: no repeat event");

  f.set(wifi("192.168.1.77")); f.tick(); // back, new address
  assert.deepEqual(f.events.at(-1), [wifi("192.168.1.77"), null]);
  assert.deepEqual(f.m.current(), wifi("192.168.1.77"));
});

test("monitor: check() forces a re-read (used right after resume) and returns whether anything changed", () => {
  const f = monitorFixture(wifi("10.0.0.5"));
  assert.equal(f.m.check(), false);
  f.set(wifi("10.0.0.6"));
  assert.equal(f.m.check(), true);
  assert.equal(f.events.length, 1);
});

test("monitor: start is idempotent and stop() really stops polling", () => {
  const f = monitorFixture(null);
  f.m.start();
  f.m.start();
  assert.ok(f.hasTimer());
  f.m.stop();
  assert.ok(f.isStopped());
  assert.ok(!f.hasTimer());
});
