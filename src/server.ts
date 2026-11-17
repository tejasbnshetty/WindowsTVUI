import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import type { Duplex } from "stream";
import { WebSocketServer, WebSocket } from "ws";
import { Command, MouseButton, ServerMessage, StateMessage, isStreamCommand, parseCommand } from "./protocol";
import { DeviceStore, TOKEN_PATTERN, createMemoryDeviceStore, deviceLabel, hashToken } from "./devices";

const MAX_PIN_FAILS = 5;
const LOCKOUT_MS = 60_000;
const MAX_BODY_BYTES = 1024;
const MAX_WS_MESSAGE_BYTES = 1024;
// Per-socket budgets, per second. Cursor/scroll streams are separate from discrete commands.
const MAX_CONTROL_PER_SEC = 40;
const MAX_STREAM_PER_SEC = 150;
// Dead peers (phone asleep / left Wi-Fi) are dropped within ~2 intervals, which releases held buttons.
const HEARTBEAT_MS = 10_000;
const DEFAULT_PAIRING_WINDOW_MS = 10 * 60_000;

export interface PairingState {
  open: boolean;
  /** Only present while pairing is open. */
  pin: string | null;
  /** null = stays open until a phone pairs (first run, no phones remembered yet). */
  expiresAt: number | null;
}

export interface RemoteServer {
  port: number;
  /** Remote URL on the LAN, or null if no LAN address was found. */
  url: string | null;
  getPairing(): PairingState;
  /** Opens (or extends) the pairing window and returns the current PIN. */
  openPairing(): PairingState;
  closePairing(): void;
  /** Forgets every remembered phone, disconnects them and re-opens pairing. */
  forgetAllDevices(): void;
  deviceCount(): number;
  broadcast(msg: ServerMessage): void;
  broadcastState(): void;
  /** Stops listening, drops all sockets (releasing held buttons) and resolves once the port is free. */
  close(): Promise<void>;
}

export interface RemoteOptions {
  /** 0 picks a free port (used by tests). */
  port: number;
  /** Called only for validated commands from authenticated sockets. `reply` answers that socket. */
  onCommand(cmd: Command, reply: (msg: ServerMessage) => void): void;
  /** Where remembered phones live. Defaults to memory only. */
  deviceStore?: DeviceStore;
  /** Sent to each socket when it connects, and on broadcastState(). */
  getState?: () => StateMessage;
  onPairingChange?: (state: PairingState) => void;
  /** How long a user-requested pairing window stays open. */
  pairingWindowMs?: number;
}

/** First non-internal IPv4 address (link-local 169.254.x.x skipped). */
export function getLanIp(): string | null {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      const family = a.family as string | number;
      if ((family === "IPv4" || family === 4) && !a.internal && !a.address.startsWith("169.254.")) {
        return a.address;
      }
    }
  }
  return null;
}

// Static files are served from an explicit whitelist: no path is ever built from the request.
const REMOTE_SRC = path.join(__dirname, "..", "src", "remote");
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: path.join(REMOTE_SRC, "index.html"), type: "text/html; charset=utf-8" },
  "/remote.css": { file: path.join(REMOTE_SRC, "remote.css"), type: "text/css; charset=utf-8" },
  "/remote.js": { file: path.join(__dirname, "remote", "remote.js"), type: "text/javascript; charset=utf-8" },
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' ws:; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

function clientIp(req: http.IncomingMessage): string {
  return (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sha256(s: string): Buffer {
  return crypto.createHash("sha256").update(s).digest();
}

function newPin(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

export function startRemoteServer(opts: RemoteOptions): Promise<RemoteServer> {
  const store = opts.deviceStore ?? createMemoryDeviceStore();
  const pairingWindowMs = opts.pairingWindowMs ?? DEFAULT_PAIRING_WINDOW_MS;

  // ---- Pairing state ----
  // Pairing is only possible while a PIN is showing. With no remembered phones it stays open
  // (first run); otherwise it must be opened on purpose and closes again after one pairing.
  let pairingOpen = store.count() === 0;
  let pin: string | null = pairingOpen ? newPin() : null;
  let pinHash = pin ? sha256(pin) : null;
  let pairingExpiresAt: number | null = null;
  let pairingTimer: NodeJS.Timeout | undefined;

  const pairingState = (): PairingState => ({ open: pairingOpen, pin: pairingOpen ? pin : null, expiresAt: pairingOpen ? pairingExpiresAt : null });

  function notifyPairing(): void {
    opts.onPairingChange?.(pairingState());
    broadcastState();
  }

  function closePairing(): void {
    clearTimeout(pairingTimer);
    pairingTimer = undefined;
    if (!pairingOpen) return;
    pairingOpen = false;
    pin = null;
    pinHash = null;
    pairingExpiresAt = null;
    notifyPairing();
  }

  function openPairing(): PairingState {
    clearTimeout(pairingTimer);
    if (!pairingOpen) {
      pairingOpen = true;
      pin = newPin();
      pinHash = sha256(pin);
    }
    if (store.count() > 0) {
      pairingExpiresAt = Date.now() + pairingWindowMs;
      pairingTimer = setTimeout(closePairing, pairingWindowMs);
      pairingTimer.unref();
    } else {
      pairingExpiresAt = null;
    }
    notifyPairing();
    return pairingState();
  }

  // ---- PIN rate limiting (per client IP) ----
  const attempts = new Map<string, { fails: number; lockedUntil: number }>();

  function lockRemainingMs(ip: string): number {
    const a = attempts.get(ip);
    return a && a.lockedUntil > Date.now() ? a.lockedUntil - Date.now() : 0;
  }
  function recordFailure(ip: string): void {
    const a = attempts.get(ip) ?? { fails: 0, lockedUntil: 0 };
    a.fails += 1;
    if (a.fails >= MAX_PIN_FAILS) {
      a.fails = 0;
      a.lockedUntil = Date.now() + LOCKOUT_MS;
    }
    attempts.set(ip, a);
  }

  function isValidToken(token: string | null | undefined): boolean {
    return !!token && TOKEN_PATTERN.test(token) && store.has(hashToken(token));
  }

  function bearerToken(req: http.IncomingMessage): string | null {
    const m = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization ?? "");
    return m ? m[1] : null;
  }

  // ---- HTTP ----
  async function handlePair(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!pairingOpen || !pinHash) {
      sendJson(res, 403, { error: "pairing closed" });
      return;
    }
    const ip = clientIp(req);
    const locked = lockRemainingMs(ip);
    if (locked > 0) {
      sendJson(res, 429, { error: "locked", retryAfter: Math.ceil(locked / 1000) });
      return;
    }

    let candidate = "";
    try {
      const parsed: unknown = JSON.parse(await readBody(req));
      if (typeof parsed === "object" && parsed !== null && typeof (parsed as { pin?: unknown }).pin === "string") {
        candidate = (parsed as { pin: string }).pin;
      }
    } catch {
      sendJson(res, 400, { error: "bad request" });
      return;
    }

    // Constant-time compare on fixed-length hashes; malformed input simply counts as a failure.
    // (Re-check pairingOpen: the window may have closed while the body was being read.)
    const ok = pairingOpen && pinHash !== null && /^\d{6}$/.test(candidate) && crypto.timingSafeEqual(sha256(candidate), pinHash);
    if (!ok) {
      recordFailure(ip);
      const after = lockRemainingMs(ip);
      if (after > 0) {
        sendJson(res, 429, { error: "locked", retryAfter: Math.ceil(after / 1000) });
      } else {
        const remaining = MAX_PIN_FAILS - (attempts.get(ip)?.fails ?? 0);
        sendJson(res, 401, { error: "wrong pin", remaining });
      }
      return;
    }

    attempts.delete(ip);
    const token = crypto.randomBytes(32).toString("hex");
    store.add({ hash: hashToken(token), label: deviceLabel(req.headers["user-agent"]), createdAt: Date.now() });
    closePairing(); // one phone per pairing window
    sendJson(res, 200, { token });
  }

  const server = http.createServer((req, res) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      sendJson(res, 400, { error: "bad request" });
      return;
    }
    const method = req.method ?? "GET";

    if (method === "POST" && pathname === "/pair") {
      handlePair(req, res).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { error: "server error" });
      });
      return;
    }

    if (method === "GET" && pathname === "/api/session") {
      const ok = isValidToken(bearerToken(req));
      sendJson(res, ok ? 200 : 401, { ok });
      return;
    }

    if ((method === "GET" || method === "HEAD") && Object.hasOwn(STATIC_FILES, pathname)) {
      const entry = STATIC_FILES[pathname];
      fs.readFile(entry.file, (err, data) => {
        if (err) {
          sendJson(res, 500, { error: "file unavailable" });
          return;
        }
        res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": entry.type });
        res.end(method === "HEAD" ? undefined : data);
      });
      return;
    }

    sendJson(res, 404, { error: "not found" });
  });

  // ---- WebSocket ----
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_MESSAGE_BYTES });

  function rejectUpgrade(socket: Duplex, status: string): void {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }

  server.on("upgrade", (req, socket) => {
    socket.on("error", () => {});
    let pathname = "";
    let token: string | null = null;
    try {
      const u = new URL(req.url ?? "/", "http://localhost");
      pathname = u.pathname;
      token = u.searchParams.get("token");
    } catch {
      rejectUpgrade(socket, "400 Bad Request");
      return;
    }
    if (pathname !== "/ws") {
      rejectUpgrade(socket, "404 Not Found");
      return;
    }
    if (!isValidToken(token)) {
      rejectUpgrade(socket, "401 Unauthorized");
      return;
    }
    wss.handleUpgrade(req, socket, Buffer.alloc(0), (ws) => wss.emit("connection", ws, req));
  });

  const alive = new WeakMap<WebSocket, boolean>();
  // Mouse buttons each socket currently holds down; released if the socket goes away.
  const held = new Map<WebSocket, Set<MouseButton>>();

  function releaseHeld(ws: WebSocket): void {
    const buttons = held.get(ws);
    held.delete(ws);
    if (!buttons) return;
    for (const button of buttons) opts.onCommand({ type: "mouse_up", button }, () => {});
  }

  function sendTo(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function broadcast(msg: ServerMessage): void {
    for (const ws of wss.clients) sendTo(ws, msg);
  }

  function broadcastState(): void {
    if (opts.getState) broadcast(opts.getState());
  }

  // Only reachable via the upgrade handler above, i.e. after token validation.
  wss.on("connection", (ws: WebSocket) => {
    alive.set(ws, true);
    held.set(ws, new Set());
    ws.on("pong", () => alive.set(ws, true));
    ws.on("error", () => {});
    ws.on("close", () => releaseHeld(ws));
    const reply = (msg: ServerMessage) => sendTo(ws, msg);
    if (opts.getState) reply(opts.getState());

    let windowStart = Date.now();
    let controlCount = 0;
    let streamCount = 0;

    ws.on("message", (data, isBinary) => {
      if (isBinary) return;

      let cmd: Command | null;
      try {
        cmd = parseCommand(JSON.parse(data.toString("utf8")));
      } catch {
        return;
      }
      if (!cmd) return; // unknown type/action or invalid values: ignored

      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        controlCount = 0;
        streamCount = 0;
      }
      // Releasing a button is never rate-limited, so a flood can't leave one stuck down.
      if (cmd.type !== "mouse_up") {
        if (isStreamCommand(cmd)) {
          if (++streamCount > MAX_STREAM_PER_SEC) return;
        } else if (++controlCount > MAX_CONTROL_PER_SEC) {
          return;
        }
      }

      const buttons = held.get(ws);
      if (cmd.type === "mouse_down") buttons?.add(cmd.button);
      else if (cmd.type === "mouse_up") buttons?.delete(cmd.button);

      opts.onCommand(cmd, reply);
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const prune = setInterval(() => {
    const now = Date.now();
    for (const [ip, a] of attempts) {
      if (a.lockedUntil <= now && a.fails === 0) attempts.delete(ip);
    }
  }, 60_000);
  prune.unref();

  function dropAllSockets(): void {
    // Release synchronously: terminate() delivers 'close' asynchronously, too late at app exit.
    for (const ws of wss.clients) {
      releaseHeld(ws);
      ws.terminate();
    }
  }

  let closing: Promise<void> | null = null;
  function close(): Promise<void> {
    if (closing) return closing;
    clearInterval(heartbeat);
    clearInterval(prune);
    clearTimeout(pairingTimer);
    dropAllSockets();
    closing = new Promise<void>((resolve) => {
      wss.close(() => {
        server.close(() => resolve());
        server.closeAllConnections?.(); // keep-alive HTTP connections would otherwise hold the port
      });
    });
    return closing;
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "0.0.0.0", () => {
      server.off("error", reject);
      const ip = getLanIp();
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port;
      resolve({
        port,
        url: ip ? `http://${ip}:${port}` : null,
        getPairing: pairingState,
        openPairing,
        closePairing,
        forgetAllDevices() {
          store.clear();
          dropAllSockets();
          openPairing();
        },
        deviceCount: () => store.count(),
        broadcast,
        broadcastState,
        close,
      });
    });
  });
}
