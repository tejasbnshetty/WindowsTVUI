// Phone remote page. Plain script (no imports/exports); wrapped in an IIFE so it
// shares no globals with the other scripts in this tsconfig.
(() => {
  const TOKEN_KEY = "tvui.token";

  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const statusEl = $("status");
  const statusText = $("status-text");
  const pairView = $("pair-view");
  const remoteView = $("remote-view");
  const pairForm = $<HTMLFormElement>("pair-form");
  const pinInput = $<HTMLInputElement>("pin");
  const pairBtn = $<HTMLButtonElement>("pair-btn");
  const pairMsg = $("pair-msg");

  // ---- token storage (localStorage may be unavailable, e.g. private mode) ----
  function getToken(): string | null {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  }
  function setToken(t: string): void {
    try { localStorage.setItem(TOKEN_KEY, t); } catch { /* ignore */ }
  }
  function clearToken(): void {
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  }

  // ---- status indicator ----
  type Status = "on" | "off" | "connecting";
  function setStatus(s: Status): void {
    statusEl.className = `status ${s}`;
    statusText.textContent = s === "on" ? "Connected" : s === "connecting" ? "Connecting…" : "Disconnected";
  }

  // ---- views ----
  let ws: WebSocket | null = null;
  let retryTimer: number | undefined;
  let retryDelay = 1000;
  let attempting = false;

  function showPair(): void {
    stopConnection();
    remoteView.hidden = true;
    pairView.hidden = false;
    setStatus("off");
    pinInput.focus();
  }

  function showRemote(): void {
    pairView.hidden = true;
    remoteView.hidden = false;
  }

  // ---- connection ----
  function stopConnection(): void {
    window.clearTimeout(retryTimer);
    retryTimer = undefined;
    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
      ws = null;
    }
  }

  /** true = token valid, false = token rejected, null = server unreachable. */
  async function checkSession(token: string): Promise<boolean | null> {
    try {
      const res = await fetch("/api/session", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      if (res.status === 200) return true;
      if (res.status === 401) return false;
      return null;
    } catch {
      return null;
    }
  }

  function scheduleReconnect(): void {
    window.clearTimeout(retryTimer);
    retryTimer = window.setTimeout(attempt, retryDelay);
    retryDelay = Math.min(retryDelay * 1.5, 5000);
  }

  async function attempt(): Promise<void> {
    if (attempting) return;
    const token = getToken();
    if (!token) { showPair(); return; }
    attempting = true;
    try {
      showRemote();
      setStatus("connecting");
      const valid = await checkSession(token);
      if (valid === false) { clearToken(); showPair(); return; }
      if (valid === null) { setStatus("off"); scheduleReconnect(); return; }
      connect(token);
    } finally {
      attempting = false;
    }
  }

  function connect(token: string): void {
    stopConnection();
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${location.host}/ws?token=${encodeURIComponent(token)}`);
    ws = socket;
    socket.onopen = () => { retryDelay = 1000; setStatus("on"); };
    socket.onclose = () => {
      if (ws === socket) ws = null;
      setStatus("off");
      scheduleReconnect();
    };
    socket.onerror = () => { /* onclose follows */ };
  }

  function send(action: string): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "nav", action }));
    }
  }

  // iOS suspends sockets in the background: reconnect right away when the page returns.
  function wake(): void {
    if (getToken() && !(ws && ws.readyState <= WebSocket.OPEN)) {
      window.clearTimeout(retryTimer);
      retryDelay = 1000;
      void attempt();
    }
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) wake(); });
  window.addEventListener("pageshow", wake);
  window.addEventListener("online", wake);

  // ---- buttons ----
  document.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((btn) => {
    const release = () => btn.classList.remove("pressed");
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      btn.classList.add("pressed");
      send(btn.dataset.action!);
    });
    btn.addEventListener("pointerup", release);
    btn.addEventListener("pointercancel", release);
    btn.addEventListener("pointerleave", release);
    btn.addEventListener("contextmenu", (e) => e.preventDefault());
  });

  // ---- pairing ----
  let lockTimer: number | undefined;

  function startLockout(seconds: number): void {
    window.clearInterval(lockTimer);
    let left = seconds;
    pairBtn.disabled = true;
    const tick = () => {
      if (left <= 0) {
        window.clearInterval(lockTimer);
        pairBtn.disabled = false;
        pairMsg.textContent = "";
        return;
      }
      pairMsg.textContent = `Too many attempts. Try again in ${left}s.`;
      left -= 1;
    };
    tick();
    lockTimer = window.setInterval(tick, 1000);
  }

  pinInput.addEventListener("input", () => {
    pinInput.value = pinInput.value.replace(/\D/g, "").slice(0, 6);
  });

  pairForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const pin = pinInput.value;
    if (!/^\d{6}$/.test(pin)) { pairMsg.textContent = "Enter all 6 digits."; return; }
    pairBtn.disabled = true;
    pairMsg.textContent = "";
    try {
      const res = await fetch("/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 200 && typeof body.token === "string") {
        setToken(body.token);
        pinInput.value = "";
        pairBtn.disabled = false;
        retryDelay = 1000;
        void attempt();
        return;
      }
      if (res.status === 429) {
        startLockout(Number(body.retryAfter) || 60);
        return;
      }
      pairMsg.textContent = res.status === 401
        ? `Wrong PIN. ${body.remaining ?? ""} ${body.remaining === 1 ? "try" : "tries"} left.`
        : "Something went wrong. Try again.";
      pinInput.value = "";
      pairBtn.disabled = false;
    } catch {
      pairMsg.textContent = "Can't reach the TV. Check Wi-Fi.";
      pairBtn.disabled = false;
    }
  });

  // ---- start ----
  if (getToken()) void attempt(); else showPair();
})();
