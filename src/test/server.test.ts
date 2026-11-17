import { test, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as http from "http";
import { WebSocket } from "ws";
import { startRemoteServer, RemoteServer } from "../server";
import { Command } from "../protocol";

let server: RemoteServer;
const received: Command[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function request(method: string, path: string, body?: string, headers: http.OutgoingHttpHeaders = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: server.port, method, path, headers }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: d }));
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

async function pair(): Promise<string> {
  const res = await request("POST", "/pair", JSON.stringify({ pin: server.pin }), { "Content-Type": "application/json" });
  assert.equal(res.status, 200);
  return JSON.parse(res.body).token as string;
}

function openSocket(token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${token}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
    ws.on("unexpected-response", (_q, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}

const send = (ws: WebSocket, m: unknown) => ws.send(typeof m === "string" ? m : JSON.stringify(m));

before(async () => {
  server = await startRemoteServer({ port: 0, onCommand: (c) => received.push(c) });
});
after(() => server.close());

test("sockets without a valid token are rejected and inject nothing", async () => {
  received.length = 0;
  await assert.rejects(new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    ws.on("open", () => { ws.send(JSON.stringify({ type: "key", key: "Enter" })); resolve(null); });
    ws.on("error", reject);
    ws.on("unexpected-response", (_q, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  }), /HTTP 401/);
  await assert.rejects(openSocket("f".repeat(64)), /HTTP 401/);
  await assert.rejects(openSocket("garbage"), /HTTP 401/);
  await sleep(100);
  assert.equal(received.length, 0);
});

test("authenticated socket: valid commands arrive, invalid ones are ignored", async () => {
  received.length = 0;
  const ws = await openSocket(await pair());
  const good: Command[] = [
    { type: "nav", action: "right" },
    { type: "mouse_move", dx: 4, dy: 5 },
    { type: "mouse_click", button: "left" },
    { type: "scroll", dx: 0, dy: 120 },
    { type: "key", key: "Alt+Left" },
    { type: "text", value: "hello" },
    { type: "media", action: "vol_up" },
  ];
  for (const g of good) send(ws, g);
  const bad = [
    { type: "key", key: "Win+R" }, { type: "exec", cmd: "calc" }, { type: "text", value: "a\nb" },
    { type: "text", value: "x".repeat(201) }, { type: "mouse_move", dx: "1", dy: 2 }, { type: "media", action: "eject" },
    "not json", "[]", "null", "{}",
  ];
  for (const b of bad) send(ws, b);
  ws.send(Buffer.from([1, 2, 3]));
  await sleep(300);
  assert.deepEqual(received, good);
  ws.close();
});

test("numeric values are clamped before reaching the handler", async () => {
  received.length = 0;
  const ws = await openSocket(await pair());
  send(ws, { type: "mouse_move", dx: 1e6, dy: -1e6 });
  send(ws, { type: "scroll", dx: 1e6, dy: -1e6 });
  await sleep(200);
  assert.deepEqual(received, [
    { type: "mouse_move", dx: 200, dy: -200 },
    { type: "scroll", dx: 600, dy: -600 },
  ]);
  ws.close();
});

test("held mouse buttons are released when the socket closes", async () => {
  received.length = 0;
  const ws = await openSocket(await pair());
  send(ws, { type: "mouse_down", button: "left" });
  send(ws, { type: "mouse_down", button: "right" });
  send(ws, { type: "mouse_up", button: "right" }); // released normally, must not be released twice
  await sleep(150);
  received.length = 0;
  ws.terminate(); // abrupt drop, like a phone leaving Wi-Fi
  await sleep(300);
  assert.deepEqual(received, [{ type: "mouse_up", button: "left" }]);
});

test("a clean close also releases", async () => {
  received.length = 0;
  const ws = await openSocket(await pair());
  send(ws, { type: "mouse_down", button: "middle" });
  await sleep(100);
  received.length = 0;
  ws.close();
  await sleep(300);
  assert.deepEqual(received, [{ type: "mouse_up", button: "middle" }]);
});

test("rate limits: control 40/s, stream 150/s, and mouse_up is never dropped", async () => {
  received.length = 0;
  const ws = await openSocket(await pair());
  for (let i = 0; i < 200; i++) send(ws, { type: "mouse_click", button: "left" });
  for (let i = 0; i < 400; i++) send(ws, { type: "mouse_move", dx: 1, dy: 1 });
  send(ws, { type: "mouse_down", button: "left" }); // over budget: dropped, so never "held"
  send(ws, { type: "mouse_up", button: "left" });   // still delivered
  await sleep(500);
  const clicks = received.filter((c) => c.type === "mouse_click").length;
  const moves = received.filter((c) => c.type === "mouse_move").length;
  const ups = received.filter((c) => c.type === "mouse_up").length;
  const downs = received.filter((c) => c.type === "mouse_down").length;
  assert.equal(clicks, 40);
  assert.equal(moves, 150);
  assert.equal(downs, 0);
  assert.equal(ups, 1);
  ws.close();
});

test("server.close() releases held buttons synchronously", async () => {
  const seen: Command[] = [];
  const s = await startRemoteServer({ port: 0, onCommand: (c) => seen.push(c) });
  const res = await new Promise<string>((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: s.port, method: "POST", path: "/pair", headers: { "Content-Type": "application/json" } }, (rs) => {
      let d = ""; rs.on("data", (c) => (d += c)); rs.on("end", () => resolve(d));
    });
    r.on("error", reject);
    r.end(JSON.stringify({ pin: s.pin }));
  });
  const token = JSON.parse(res).token;
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const w = new WebSocket(`ws://127.0.0.1:${s.port}/ws?token=${token}`);
    w.on("open", () => resolve(w));
    w.on("error", reject);
  });
  ws.send(JSON.stringify({ type: "mouse_down", button: "left" }));
  await sleep(150);
  seen.length = 0;
  s.close();
  assert.deepEqual(seen, [{ type: "mouse_up", button: "left" }]);
  ws.terminate();
});
