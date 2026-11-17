import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { WebSocketServer, WebSocket } from "ws";
import { Command, MouseButton, isStreamCommand, parseCommand } from "./protocol";

const MAX_PIN_FAILS = 5;
const LOCKOUT_MS = 60_000;
const MAX_BODY_BYTES = 1024;
const MAX_WS_MESSAGE_BYTES = 1024;
// Per-socket budgets, per second. Cursor/scroll streams are separate from discrete commands.
const MAX_CONTROL_PER_SEC = 40;
const MAX_STREAM_PER_SEC = 150;
// Dead peers (phone asleep / left Wi-Fi) are dropped within ~2 intervals, which releases held buttons.
const HEARTBEAT_MS = 10_000;

export interface RemoteServer {
  pin: string;
  port: number;
  /** Remote URL on the LAN, or null if no LAN address was found. */
  url: string | null;
  close(): void;
}

export interface RemoteOptions {
  /** 0 picks a free port (used by tests). */
  port: number;
  /** Called only for validated commands from authenticated sockets. */
  onCommand(cmd: Command): void;
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

export function startRemoteServer(opts: RemoteOptions): Promise<RemoteServer> {
  const pin = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const pinHash = sha256(pin);
  const tokens = new Set<string>(); // one random token per paired device, memory only

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

  function bearerToken(req: http.IncomingMessage): string | null {
    const m = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization ?? "");
    return m ? m[1] : null;
  }

  // ---- HTTP ----
  async function handlePair(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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
    const ok = /^\d{6}$/.test(candidate) && crypto.timingSafeEqual(sha256(candidate), pinHash);
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
    tokens.add(token);
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
      const token = bearerToken(req);
      sendJson(res, token && tokens.has(token) ? 200 : 401, { ok: !!(token && tokens.has(token)) });
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

  function rejectUpgrade(socket: import("stream").Duplex, status: string): void {
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
    if (!token || !tokens.has(token)) {
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
    for (const button of buttons) opts.onCommand({ type: "mouse_up", button });
  }

  // Only reachable via the upgrade handler above, i.e. after token validation.
  wss.on("connection", (ws: WebSocket) => {
    alive.set(ws, true);
    held.set(ws, new Set());
    ws.on("pong", () => alive.set(ws, true));
    ws.on("error", () => {});
    ws.on("close", () => releaseHeld(ws));

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

      opts.onCommand(cmd);
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

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "0.0.0.0", () => {
      server.off("error", reject);
      const ip = getLanIp();
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port;
      resolve({
        pin,
        port,
        url: ip ? `http://${ip}:${port}` : null,
        close() {
          clearInterval(heartbeat);
          clearInterval(prune);
          // Release synchronously: terminate() delivers 'close' asynchronously, too late at app exit.
          for (const ws of wss.clients) {
            releaseHeld(ws);
            ws.terminate();
          }
          server.close();
        },
      });
    });
  });
}
