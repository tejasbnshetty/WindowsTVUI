import { test } from "node:test";
import * as assert from "node:assert/strict";
import { MDNS_HOST, MdnsFactory, createMdnsAdvertiser } from "../mdns";

/** A fake Bonjour: records publishes/stops, can fail on demand. Nothing touches the network. */
function fake(opts: { throwOnPublish?: boolean } = {}) {
  const published: Array<{ host: string; name: string; port: number; ip: string | null }> = [];
  const stopped: number[] = [];
  const errorCallbacks: Array<(e: Error) => void> = [];
  const factory: MdnsFactory = {
    publish(o, onError) {
      if (opts.throwOnPublish) throw new Error("bind failed");
      const id = published.push(o) - 1;
      errorCallbacks.push(onError);
      return { stop: async () => { stopped.push(id); } };
    },
  };
  return { factory, published, stopped, errorCallbacks };
}

test("advertises couchui.local on the LAN address and port", () => {
  const f = fake();
  const m = createMdnsAdvertiser({ factory: f.factory });
  m.start(8787, "192.168.1.229");
  assert.deepEqual(f.published, [{ host: "couchui.local", name: "Couch UI", port: 8787, ip: "192.168.1.229" }]);
  assert.equal(MDNS_HOST, "couchui.local");
  assert.deepEqual(m.state(), { running: true, host: "couchui.local", ip: "192.168.1.229", port: 8787, error: null });
});

test("IP changes while running: the old announcement is withdrawn and a new one is published", async () => {
  const f = fake();
  const m = createMdnsAdvertiser({ factory: f.factory });
  m.start(8787, "192.168.1.229");
  m.update("192.168.1.77");
  await Promise.resolve();
  assert.equal(f.published.length, 2);
  assert.equal(f.published[1].ip, "192.168.1.77");
  assert.deepEqual(f.stopped, [0], "the first announcement was stopped (goodbye packets)");
  assert.equal(m.state().ip, "192.168.1.77");
  assert.equal(m.state().running, true);
});

test("same IP again: nothing is re-published", () => {
  const f = fake();
  const m = createMdnsAdvertiser({ factory: f.factory });
  m.start(8787, "10.0.0.2");
  m.update("10.0.0.2");
  m.update("10.0.0.2");
  assert.equal(f.published.length, 1);
});

test("network lost: advertising stops; network back: it resumes on the new address with the remembered port", async () => {
  const f = fake();
  const m = createMdnsAdvertiser({ factory: f.factory });
  m.start(9000, "10.0.0.2");
  m.update(null);
  await Promise.resolve();
  assert.equal(m.state().running, false);
  assert.deepEqual(f.stopped, [0]);
  m.update(null); // still down: no-op
  assert.equal(f.published.length, 1);
  m.update("10.0.0.9");
  assert.equal(f.published.length, 2);
  assert.deepEqual({ port: f.published[1].port, ip: f.published[1].ip }, { port: 9000, ip: "10.0.0.9" });
  assert.equal(m.state().running, true);
});

test("started with no network: nothing is published until an address shows up", () => {
  const f = fake();
  const m = createMdnsAdvertiser({ factory: f.factory });
  m.start(8787, null);
  assert.equal(f.published.length, 0);
  assert.equal(m.state().running, false);
  m.update("192.168.0.4");
  assert.equal(f.published.length, 1);
});

test("a publish that throws is contained: error recorded, no crash, and a later update retries", () => {
  const f = fake({ throwOnPublish: true });
  const logs: string[] = [];
  const m = createMdnsAdvertiser({ factory: f.factory, log: (l) => logs.push(l) });
  assert.doesNotThrow(() => m.start(8787, "10.0.0.2"));
  assert.equal(m.state().running, false);
  assert.equal(m.state().error, "bind failed");
  assert.ok(logs.some((l) => /could not start/.test(l)));
  assert.doesNotThrow(() => m.update("10.0.0.2")); // same IP, but not running -> tries again
});

test("runtime errors from the mDNS socket are recorded, never thrown; stale ones are ignored", () => {
  const f = fake();
  const m = createMdnsAdvertiser({ factory: f.factory });
  m.start(8787, "10.0.0.2");
  assert.doesNotThrow(() => f.errorCallbacks[0](new Error("EADDRINUSE 5353")));
  assert.equal(m.state().error, "EADDRINUSE 5353");
  m.update("10.0.0.3"); // re-publish clears the error
  assert.equal(m.state().error, null);
  f.errorCallbacks[0](new Error("late error from the old socket"));
  assert.equal(m.state().error, null, "errors from a replaced announcement are ignored");
});

test("stop() withdraws the announcement and is safe to repeat", async () => {
  const f = fake();
  const m = createMdnsAdvertiser({ factory: f.factory });
  m.start(8787, "10.0.0.2");
  await m.stop();
  await m.stop();
  assert.deepEqual(f.stopped, [0]);
  assert.equal(m.state().running, false);
});

test("a stop() that fails does not break shutdown", async () => {
  const factory: MdnsFactory = { publish: () => ({ stop: async () => { throw new Error("socket already closed"); } }) };
  const m = createMdnsAdvertiser({ factory, log: () => {} });
  m.start(8787, "10.0.0.2");
  await assert.doesNotReject(m.stop());
});
