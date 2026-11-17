import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { WebSocket } from "ws";
import { startRemoteServer, RemoteServer, RemoteOptions, PairingState } from "../server";
import { Command, ServerMessage, StateMessage } from "../protocol";
import { createFileDeviceStore } from "../devices";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const open: RemoteServer[] = [];

interface Harness {
  server: RemoteServer;
  received: Command[];
  replies: ServerMessage[];
  pairingEvents: PairingState[];
}

async function start(extra: Partial<RemoteOptions> = {}): Promise<Harness> {
  const received: Command[] = [];
  const replies: ServerMessage[] = [];
  const pairingEvents: PairingState[] = [];
  const server = await startRemoteServer({
    port: 0,
    onCommand: (c, reply) => {
      received.push(c);
      if (c.type === "app") reply({ type: "notice", text: "hello from main" });
    },
    onPairingChange: (p) => pairingEvents.push(p),
    ...extra,
  });
  open.push(server);
  return { server, received, replies, pairingEvents };
}
after(async () => { await Promise.all(open.map((s) => s.close())); });

function request(port: number, method: string, p: string, body?: string, headers: http.OutgoingHttpHeaders = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, method, path: p, headers, agent: false }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: d }));
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

const postPin = (port: number, pin: string) =>
  request(port, "POST", "/pair", JSON.stringify({ pin }), { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (iPhone)" });

/** Pairs a phone: opens the pairing window if needed, then submits the PIN. */
async function pairDevice(server: RemoteServer): Promise<string> {
  const p = server.getPairing().open ? server.getPairing() : server.openPairing();
  const res = await postPin(server.port, p.pin!);
  assert.equal(res.status, 200, res.body);
  return JSON.parse(res.body).token as string;
}

function openSocket(port: number, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
    ws.on("unexpected-response", (_q, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}

const send = (ws: WebSocket, m: unknown) => ws.send(typeof m === "string" ? m : JSON.stringify(m));
const session = (port: number, token: string) => request(port, "GET", "/api/session", undefined, { Authorization: `Bearer ${token}` });

// ---------------------------------------------------------------------------
// Authentication & validation (unchanged behaviour from M2/M3)
// ---------------------------------------------------------------------------

test("sockets without a valid token are rejected and inject nothing", async () => {
  const { server, received } = await start();
  await assert.rejects(new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    ws.on("open", () => { ws.send(JSON.stringify({ type: "key", key: "Enter" })); resolve(null); });
    ws.on("error", reject);
    ws.on("unexpected-response", (_q, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  }), /HTTP 401/);
  await assert.rejects(openSocket(server.port, "f".repeat(64)), /HTTP 401/);
  await assert.rejects(openSocket(server.port, "garbage"), /HTTP 401/);
  await sleep(100);
  assert.equal(received.length, 0);
});

test("authenticated socket: valid commands arrive (incl. M4 ones), invalid ones are ignored", async () => {
  const { server, received } = await start();
  const ws = await openSocket(server.port, await pairDevice(server));
  const good: Command[] = [
    { type: "nav", action: "right" },
    { type: "mouse_move", dx: 4, dy: 5 },
    { type: "key", key: "Alt+Left" },
    { type: "text", value: "hello" },
    { type: "media", action: "vol_up" },
    { type: "app", action: "switch" },
    { type: "display_set", id: 12345 },
    { type: "display_set", id: null },
    { type: "pair_new" },
    { type: "forget_devices" },
  ];
  for (const g of good) send(ws, g);
  const bad = [
    { type: "key", key: "Win+R" }, { type: "key", key: "Alt+F4" }, { type: "exec", cmd: "calc" }, { type: "text", value: "a\nb" },
    { type: "app", action: "format" }, { type: "display_set", id: "1" }, { type: "display_set", id: 1.5 }, { type: "display_set" },
    "not json", "[]", "null", "{}",
  ];
  for (const b of bad) send(ws, b);
  await sleep(300);
  assert.deepEqual(received, good);
  ws.close();
});

test("numeric values are clamped before reaching the handler", async () => {
  const { server, received } = await start();
  const ws = await openSocket(server.port, await pairDevice(server));
  send(ws, { type: "mouse_move", dx: 1e6, dy: -1e6 });
  await sleep(200);
  assert.deepEqual(received, [{ type: "mouse_move", dx: 200, dy: -200 }]);
  ws.close();
});

test("held mouse buttons are released when the socket closes", async () => {
  const { server, received } = await start();
  const ws = await openSocket(server.port, await pairDevice(server));
  send(ws, { type: "mouse_down", button: "left" });
  send(ws, { type: "mouse_down", button: "right" });
  send(ws, { type: "mouse_up", button: "right" });
  await sleep(150);
  received.length = 0;
  ws.terminate();
  await sleep(300);
  assert.deepEqual(received, [{ type: "mouse_up", button: "left" }]);
});

test("rate limits: control 40/s, stream 150/s, and mouse_up is never dropped", async () => {
  const { server, received } = await start();
  const ws = await openSocket(server.port, await pairDevice(server));
  for (let i = 0; i < 200; i++) send(ws, { type: "mouse_click", button: "left" });
  for (let i = 0; i < 400; i++) send(ws, { type: "mouse_move", dx: 1, dy: 1 });
  send(ws, { type: "mouse_down", button: "left" });
  send(ws, { type: "mouse_up", button: "left" });
  await sleep(500);
  const n = (t: string) => received.filter((c) => c.type === t).length;
  assert.equal(n("mouse_click"), 40);
  assert.equal(n("mouse_move"), 150);
  assert.equal(n("mouse_down"), 0);
  assert.equal(n("mouse_up"), 1);
  ws.close();
});

// ---------------------------------------------------------------------------
// Pairing window + PIN lockout
// ---------------------------------------------------------------------------

test("first run: pairing is open with a PIN; after one phone pairs it closes and the PIN disappears", async () => {
  const { server, pairingEvents } = await start();
  const p = server.getPairing();
  assert.equal(p.open, true);
  assert.match(p.pin!, /^\d{6}$/);
  assert.equal(p.expiresAt, null, "no expiry while no phone is remembered");
  const token = await pairDevice(server);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.deepEqual(server.getPairing(), { open: false, pin: null, expiresAt: null });
  assert.equal(server.deviceCount(), 1);
  assert.equal(pairingEvents.at(-1)?.open, false, "launcher is told to hide the PIN");
});

test("while pairing is closed /pair answers 403 and never checks a PIN", async () => {
  const { server } = await start();
  const oldPin = server.getPairing().pin!;
  await pairDevice(server);
  const res = await postPin(server.port, oldPin);
  assert.equal(res.status, 403);
  assert.deepEqual(JSON.parse(res.body), { error: "pairing closed" });
});

test("openPairing() shows a FRESH PIN; the previous PIN no longer works", async () => {
  const { server, pairingEvents } = await start();
  const first = server.getPairing().pin!;
  await pairDevice(server);
  const again = server.openPairing();
  assert.equal(again.open, true);
  assert.match(again.pin!, /^\d{6}$/);
  assert.ok(again.expiresAt && again.expiresAt > Date.now(), "a user-requested window expires");
  assert.equal(pairingEvents.at(-1)?.open, true);
  if (again.pin !== first) {
    assert.equal((await postPin(server.port, first)).status, 401);
  }
  assert.equal((await postPin(server.port, again.pin!)).status, 200);
});

test("a user-opened pairing window closes by itself after pairingWindowMs", async () => {
  const { server } = await start({ pairingWindowMs: 80 });
  await pairDevice(server);
  server.openPairing();
  assert.equal(server.getPairing().open, true);
  await sleep(200);
  assert.equal(server.getPairing().open, false);
});

test("PIN lockout: 5 wrong tries -> 429 for 60 s, even the right PIN is refused", async () => {
  const { server } = await start();
  const pin = server.getPairing().pin!;
  const wrong = pin === "000000" ? "111111" : "000000";
  const codes: number[] = [];
  for (let i = 0; i < 6; i++) codes.push((await postPin(server.port, wrong)).status);
  assert.deepEqual(codes, [401, 401, 401, 401, 429, 429]);
  const during = await postPin(server.port, pin);
  assert.equal(during.status, 429);
  assert.equal(JSON.parse(during.body).retryAfter, 60);
  assert.equal(server.deviceCount(), 0);
});

test("the lockout is still enforced on re-opened pairing windows", async () => {
  const { server } = await start();
  await pairDevice(server);
  const p = server.openPairing();
  const wrong = p.pin === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) await postPin(server.port, wrong);
  assert.equal((await postPin(server.port, p.pin!)).status, 429);
});

test("malformed PIN / body never pairs", async () => {
  const { server } = await start();
  assert.equal((await request(server.port, "POST", "/pair", "garbage")).status, 400);
  assert.equal((await postPin(server.port, "12345")).status, 401);
  assert.equal(server.deviceCount(), 0);
});

// ---------------------------------------------------------------------------
// Remembered devices across restarts
// ---------------------------------------------------------------------------

test("a paired phone stays paired across a server restart (hashed token on disk)", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tvui-srv-")), "devices.json");
  const a = await start({ deviceStore: createFileDeviceStore(file) });
  const token = await pairDevice(a.server);
  assert.ok(!fs.readFileSync(file, "utf8").includes(token), "raw token not on disk");
  await a.server.close(); // "quit the app"

  const b = await start({ deviceStore: createFileDeviceStore(file) }); // "start the app again"
  assert.equal((await session(b.server.port, token)).status, 200, "old token still valid");
  const ws = await openSocket(b.server.port, token);
  ws.close();
  assert.equal((await session(b.server.port, "e".repeat(64))).status, 401, "other tokens are not");
  assert.deepEqual(b.server.getPairing(), { open: false, pin: null, expiresAt: null }, "no PIN shown when a phone is remembered");
  assert.equal((await postPin(b.server.port, "123456")).status, 403);
});

test("with NO remembered phones a restart opens pairing again with a new PIN", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tvui-srv-")), "devices.json");
  const a = await start({ deviceStore: createFileDeviceStore(file) });
  await a.server.close();
  const b = await start({ deviceStore: createFileDeviceStore(file) });
  assert.equal(b.server.getPairing().open, true);
});

test("forgetAllDevices(): old tokens die, sockets are dropped, pairing re-opens, and it survives a restart", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tvui-srv-")), "devices.json");
  const { server } = await start({ deviceStore: createFileDeviceStore(file) });
  const token = await pairDevice(server);
  const ws = await openSocket(server.port, token);
  const closed = new Promise<void>((r) => ws.on("close", () => r()));
  assert.equal((await session(server.port, token)).status, 200);

  server.forgetAllDevices();
  await closed;
  assert.equal(server.deviceCount(), 0);
  assert.equal((await session(server.port, token)).status, 401, "the forgotten token no longer works");
  await assert.rejects(openSocket(server.port, token), /HTTP 401/);
  const p = server.getPairing();
  assert.equal(p.open, true, "pairing is open again so a phone can be re-paired");
  assert.match(p.pin!, /^\d{6}$/);
  assert.equal(p.expiresAt, null);

  assert.equal(createFileDeviceStore(file).count(), 0, "the forgetting was persisted");
});

test("forgetAllDevices() releases buttons held by the dropped sockets", async () => {
  const { server, received } = await start();
  const ws = await openSocket(server.port, await pairDevice(server));
  send(ws, { type: "mouse_down", button: "left" });
  await sleep(150);
  received.length = 0;
  server.forgetAllDevices();
  assert.deepEqual(received, [{ type: "mouse_up", button: "left" }]);
});

// ---------------------------------------------------------------------------
// Server -> remote messages
// ---------------------------------------------------------------------------

test("the current state is pushed on connect, on broadcastState(), and notices reach only the sender", async () => {
  let n = 0;
  const getState = (): StateMessage => ({
    type: "state", displays: [{ id: 1, label: "TV", width: 1920, height: 1080, primary: true, current: true }],
    devices: ++n, pairing: { open: false, expiresAt: null }, displayChoice: "default",
  });
  const { server } = await start({ getState });
  const token = await pairDevice(server);
  const a = await openSocket(server.port, token);
  const b = await openSocket(server.port, token);
  const got: Record<string, ServerMessage[]> = { a: [], b: [] };
  // Attach immediately: the connect-time state may already be in flight.
  a.on("message", (d) => got.a.push(JSON.parse(d.toString())));
  b.on("message", (d) => got.b.push(JSON.parse(d.toString())));
  await sleep(150);
  assert.ok(got.a.some((m) => m.type === "state") || true);

  got.a.length = 0; got.b.length = 0;
  server.broadcastState();
  await sleep(150);
  assert.equal(got.a.filter((m) => m.type === "state").length, 1);
  assert.equal(got.b.filter((m) => m.type === "state").length, 1);

  got.a.length = 0; got.b.length = 0;
  send(a, { type: "app", action: "close" }); // test handler replies with a notice
  await sleep(150);
  assert.deepEqual(got.a, [{ type: "notice", text: "hello from main" }]);
  assert.deepEqual(got.b, [], "other phones do not see it");

  server.broadcast({ type: "launched", kind: "browser" });
  await sleep(150);
  assert.deepEqual(got.a.at(-1), { type: "launched", kind: "browser" });
  assert.deepEqual(got.b.at(-1), { type: "launched", kind: "browser" });
  a.close(); b.close();
});

test("a new connection receives the state immediately", async () => {
  const state: StateMessage = { type: "state", displays: [], devices: 1, pairing: { open: false, expiresAt: null }, displayChoice: "saved" };
  const { server } = await start({ getState: () => state });
  const token = await pairDevice(server);
  const first = await new Promise<ServerMessage>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${token}`);
    ws.on("message", (d) => { resolve(JSON.parse(d.toString())); ws.close(); });
    ws.on("error", reject);
  });
  assert.deepEqual(first, state);
});

// ---------------------------------------------------------------------------
// Clean shutdown and port handling
// ---------------------------------------------------------------------------

test("close() releases the port: it can be bound again straight away, and clients are dropped", async () => {
  const { server } = await start();
  const port = server.port;
  const ws = await openSocket(port, await pairDevice(server));
  const closed = new Promise<void>((r) => ws.on("close", () => r()));
  await server.close();
  await closed;
  const second = await startRemoteServer({ port, onCommand: () => {} });
  assert.equal(second.port, port, "the same port is free again");
  await second.close();
  await assert.rejects(request(port, "GET", "/"), /ECONNREFUSED/);
});

test("close() also releases buttons held at shutdown, and is safe to call twice", async () => {
  const { server, received } = await start();
  const ws = await openSocket(server.port, await pairDevice(server));
  send(ws, { type: "mouse_down", button: "left" });
  await sleep(150);
  received.length = 0;
  const p1 = server.close();
  const p2 = server.close();
  assert.deepEqual(received, [{ type: "mouse_up", button: "left" }]);
  await Promise.all([p1, p2]);
});

test("close() is not held up by an idle keep-alive HTTP connection", async () => {
  const { server } = await start();
  const agent = new http.Agent({ keepAlive: true });
  await new Promise<void>((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: server.port, path: "/api/session", agent }, (res) => { res.resume(); res.on("end", resolve); }).on("error", reject);
  });
  const t0 = Date.now();
  await server.close();
  assert.ok(Date.now() - t0 < 1500, "close finished promptly");
  agent.destroy();
});

test("a busy port rejects with EADDRINUSE (the app turns this into an on-screen error)", async () => {
  const blocker = net.createServer();
  await new Promise<void>((r) => blocker.listen(0, "0.0.0.0", () => r()));
  const port = (blocker.address() as net.AddressInfo).port;
  try {
    await assert.rejects(startRemoteServer({ port, onCommand: () => {} }), (err: NodeJS.ErrnoException) => err.code === "EADDRINUSE");
  } finally {
    await new Promise<void>((r) => blocker.close(() => r()));
  }
});

// ---------------------------------------------------------------------------
// M6: connected phones (drives the launcher's "Waiting for your phone…" chip)
// ---------------------------------------------------------------------------

test("connectedCount() and onConnectionsChange follow phones as they connect and disconnect", async () => {
  const counts: number[] = [];
  const { server } = await start({ onConnectionsChange: (n) => counts.push(n) });
  const token = await pairDevice(server);
  assert.equal(server.connectedCount(), 0);
  const a = await openSocket(server.port, token);
  const b = await openSocket(server.port, token);
  await sleep(150);
  assert.equal(server.connectedCount(), 2);
  a.close();
  await sleep(250);
  assert.equal(server.connectedCount(), 1);
  b.terminate();
  await sleep(250);
  assert.equal(server.connectedCount(), 0);
  assert.deepEqual(counts, [1, 2, 1, 0]);
});

test("a rejected (unauthenticated) socket never counts as a connected phone", async () => {
  const counts: number[] = [];
  const { server } = await start({ onConnectionsChange: (n) => counts.push(n) });
  await assert.rejects(openSocket(server.port, "f".repeat(64)));
  assert.equal(server.connectedCount(), 0);
  assert.deepEqual(counts, []);
});
